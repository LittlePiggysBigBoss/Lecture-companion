import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { GoogleGenAI, ThinkingLevel, Type } from '@google/genai';
import type { GenerateContentResponse } from '@google/genai';
import type {
  AttachmentKind,
  AttachmentSummary,
  BatchExecutionState,
  ColorPaletteTheme,
  DepthPreset,
  DocMode,
  ExpandedPlan,
  GeneratedFigureAsset,
  GeneratedVolumeArtifact,
  JobBillingSnapshot,
  ModelUsageStat,
  OutputVolumeSpec,
  PageOrientationMode,
  PipelineJob,
  PostCompletionExpansionMode,
  ResumeStrategy,
  ScannedLinkResult,
  SupplementalDirective,
  TaskBatchSpec,
  VolumeRole,
  VolumeSplitMode,
} from '../types.ts';
import { renderAcademicMarkdown } from '../utils/markdownMathRenderer.ts';
import {
  clampModuleWordsToQualitySweetSpot,
  computeMultiModelTokenCostSavingsPct,
  getToolModelEntry,
  injectGeneratedFiguresIntoModuleMarkdown,
  resolveColorPaletteSpec,
  routeSpecialistModelForBatch,
  stitchModularSectionsIntoDocument,
} from '../utils/modelRegistryAndRouter.ts';
import {
  BATCH_COMPLETE_MARKER,
  buildDriveArchivePath,
  computeResumeDescriptor,
  countAcademicMetrics,
  evaluateBatchContinuation,
  isJobActiveStage,
  mergeContinuationMarkdown,
  normalizePdfFileName,
  sanitizeFolderSegment,
} from '../utils/pipelineLogic.ts';
import {
  buildLongContextMemoryPrompt,
  extractAcademicHeadingAndSymbolLedger,
  extractRecognizedLinks,
  windowLongMarkdownContext,
} from '../utils/linkAndMemoryLogic.ts';
import {
  buildDeterministicFallbackPlan,
  buildTokenEfficientExecutionContext,
  computeVolumeArtifactsFromBatches,
  consolidateRequirementsPure,
  detectMultiVolumeIntent,
  normalizeAdaptivePlanAndVolumes,
  SINGLE_CALL_TARGET_WORDS_BY_DEPTH,
} from '../utils/adaptiveWorkflowLogic.ts';
import {
  normalizeEmail,
  SUPER_ADMIN_EMAIL,
} from '../utils/billingAndQuota.ts';
import {
  getUserCloudConfig,
  reconcileActualJobTokens,
} from './accountAndBillingStore.ts';
import { scanAndIngestLinksFromInput } from './linkScannerService.ts';
import { resolveStoredFileToGeminiPart } from './unlimitedFileStore.ts';
import {
  computeHeadlessPdfTimeoutMs,
  detectResolvedPageOrientation,
  isRecoverablePipelineError,
  isValidPdfBuffer,
  rewriteKatexCssLocalFonts,
  shouldCompileMergedFullPdfInWorker,
  shouldUseRemoteGoogleFontsInPdf,
} from '../utils/pdfServerHelpers.ts';

export const CARBON_MODEL = 'gemini-4-carbon';
const SNAPSHOT_FOLDER_NAME = '_云端任务快照 (Task Snapshots)';

export interface ServerAttachmentPayload {
  name: string;
  mimeType: string;
  kind: AttachmentKind;
  size?: number;
  base64Data?: string;
  extractedText?: string;
  serverFileId?: string;
  fileUri?: string;
}

const DATA_DIR = path.resolve(process.cwd(), '.carbon-jobs');
const JOBS_FILE = path.join(DATA_DIR, 'jobs.json');
const PDF_CACHE_DIR = path.join(DATA_DIR, 'pdfs');
const ATT_CACHE_DIR = path.join(DATA_DIR, 'attachments');
const MEDIA_CACHE_DIR = path.join(DATA_DIR, 'media');

function ensureStorageDirs(): void {
  fs.mkdirSync(PDF_CACHE_DIR, { recursive: true });
  fs.mkdirSync(ATT_CACHE_DIR, { recursive: true });
  fs.mkdirSync(MEDIA_CACHE_DIR, { recursive: true });
}

export function getJobMediaFile(
  jobId: string,
  fileName: string
): { filePath: string; mimeType: string } | null {
  const safeJobId = path.basename(jobId);
  const safeFile = path.basename(fileName);
  const fullPath = path.join(MEDIA_CACHE_DIR, safeJobId, safeFile);
  if (!fs.existsSync(fullPath)) return null;
  const ext = path.extname(safeFile).toLowerCase();
  const mimeType =
    ext === '.jpg' || ext === '.jpeg'
      ? 'image/jpeg'
      : ext === '.webp'
        ? 'image/webp'
        : 'image/png';
  return { filePath: fullPath, mimeType };
}

// In-memory server state (persisted to .carbon-jobs/jobs.json and mirrored to each user's Google Cloud)
const jobsMap = new Map<string, PipelineJob>();
const activeControllers = new Map<string, AbortController>();

// Strictly per-user & per-job in-memory OAuth access tokens (never written to disk, never shared across users)
const jobDriveTokens = new Map<string, string>();
const userDriveTokens = new Map<string, string>();

function persistJobsToDisk(): void {
  try {
    ensureStorageDirs();
    const list = Array.from(jobsMap.values()).sort((a, b) =>
      b.createdAt.localeCompare(a.createdAt)
    );
    const tmpPath = `${JOBS_FILE}.tmp`;
    fs.writeFileSync(tmpPath, JSON.stringify(list, null, 2), 'utf-8');
    fs.renameSync(tmpPath, JOBS_FILE);
  } catch (err) {
    console.error('Failed to persist jobs store:', err);
  }
}

const MAX_AUTO_HEAL_WATCHDOG_CYCLES = 6;
let autonomousWatchdogTimer: ReturnType<typeof setInterval> | null = null;

function startAutonomousPipelineWatchdog(): void {
  if (autonomousWatchdogTimer) return;
  autonomousWatchdogTimer = setInterval(() => {
    const now = Date.now();
    for (const job of jobsMap.values()) {
      // Never auto-resume jobs explicitly paused/cancelled by the user or already completed
      if (job.stage === 'cancelled' || job.stage === 'completed') {
        continue;
      }

      const healCount = job.autoHealWatchdogCount || 0;
      if (healCount >= MAX_AUTO_HEAL_WATCHDOG_CYCLES) {
        continue;
      }

      const lastBeatMs = Date.parse(job.lastHeartbeatAt || job.updatedAt || job.createdAt) || 0;
      const idleMs = now - lastBeatMs;

      // Case 1: Job is marked active (`planning` / `executing` / `compiling_pdf` / `uploading_drive`),
      //         either orphaned without an active controller OR stalled past its heartbeat budget
      if (isJobActiveStage(job.stage)) {
        const hasController = activeControllers.has(job.id);
        const stallBudgetMs = job.stage === 'compiling_pdf' ? 240_000 : 140_000;
        if ((!hasController && idleMs > 6_000) || (hasController && idleMs > stallBudgetMs)) {
          const oldCtrl = activeControllers.get(job.id);
          if (oldCtrl) {
            activeControllers.delete(job.id);
            oldCtrl.abort();
          }
          const bumped: PipelineJob = {
            ...job,
            autoHealWatchdogCount: healCount + 1,
            autoRecoveryCount: (job.autoRecoveryCount || 0) + 1,
            lastHeartbeatAt: new Date().toISOString(),
          };
          jobsMap.set(job.id, bumped);
          console.log(
            `[Autonomous Watchdog] Self-healing stalled ${job.stage} job ${job.id} (idle ${Math.round(idleMs / 1000)}s, cycle #${healCount + 1})`
          );
          resumeDetachedJob({
            incomingJob: bumped,
            strategy: 'continue',
            ownerEmail: bumped.ownerEmail,
          });
        }
        continue;
      }

      // Case 2: Job hit a recoverable `error` (transient network/API hiccup, stream reset, or KaTeX/PDF glitch)
      //         -> Automatically self-heal from exact checkpoint without waiting for manual user clicks!
      if (
        job.stage === 'error' &&
        !activeControllers.has(job.id) &&
        idleMs >= 10_000 &&
        isRecoverablePipelineError(job.errorMessage)
      ) {
        const bumped: PipelineJob = {
          ...job,
          autoHealWatchdogCount: healCount + 1,
          autoRecoveryCount: (job.autoRecoveryCount || 0) + 1,
          lastHeartbeatAt: new Date().toISOString(),
        };
        jobsMap.set(job.id, bumped);
        console.log(
          `[Autonomous Watchdog] Auto-recovering error job ${job.id} (${job.failedStage || 'unknown'}): ${job.errorMessage?.slice(0, 80)}`
        );
        resumeDetachedJob({
          incomingJob: bumped,
          strategy: 'continue',
          ownerEmail: bumped.ownerEmail,
        });
      }
    }
  }, 15_000);
  autonomousWatchdogTimer.unref?.();
}

export function loadJobsFromDisk(): void {
  startAutonomousPipelineWatchdog();
  try {
    ensureStorageDirs();
    if (!fs.existsSync(JOBS_FILE)) return;
    const raw = fs.readFileSync(JOBS_FILE, 'utf-8');
    const parsed = JSON.parse(raw) as PipelineJob[];
    if (!Array.isArray(parsed)) return;

    const jobsToAutoResume: PipelineJob[] = [];

    for (const item of parsed) {
      const normalizedOwner = item.ownerEmail
        ? normalizeEmail(item.ownerEmail)
        : SUPER_ADMIN_EMAIL;
      const hadActiveBatch = item.batches?.some(
        (b) => b.status === 'running' || b.status === 'continuing'
      );
      const isRecoverableErr =
        item.stage === 'error' &&
        isRecoverablePipelineError(item.errorMessage) &&
        (item.autoHealWatchdogCount || 0) < MAX_AUTO_HEAL_WATCHDOG_CYCLES;

      const hydrated: PipelineJob = {
        ...item,
        ownerEmail: normalizedOwner,
      };
      jobsMap.set(hydrated.id, hydrated);

      // Seamless Zero-Interruption Upgrade & Auto-Heal: resume active OR recoverable error jobs on server boot!
      if (
        isJobActiveStage(hydrated.stage) ||
        (hydrated.stage !== 'completed' && hydrated.stage !== 'cancelled' && hadActiveBatch) ||
        isRecoverableErr
      ) {
        jobsToAutoResume.push(
          isRecoverableErr
            ? {
                ...hydrated,
                autoHealWatchdogCount: (hydrated.autoHealWatchdogCount || 0) + 1,
                autoRecoveryCount: (hydrated.autoRecoveryCount || 0) + 1,
              }
            : hydrated
        );
      }
    }

    persistJobsToDisk();

    if (jobsToAutoResume.length > 0) {
      setTimeout(() => {
        for (const activeItem of jobsToAutoResume) {
          if (!activeControllers.has(activeItem.id)) {
            console.log(
              `[Zero-Pause Autonomous Boot] Resuming/healing cloud job: ${activeItem.id} (prev stage: ${activeItem.stage})`
            );
            resumeDetachedJob({
              incomingJob: activeItem,
              strategy: 'continue',
              ownerEmail: activeItem.ownerEmail,
            });
          }
        }
      }, 350);
    }
  } catch (err) {
    console.error('Failed to load jobs store:', err);
  }
}

function saveJobAttachments(jobId: string, attachments: ServerAttachmentPayload[]): void {
  if (!attachments || attachments.length === 0) return;
  try {
    ensureStorageDirs();
    const filePath = path.join(ATT_CACHE_DIR, `${jobId}.json`);
    fs.writeFileSync(filePath, JSON.stringify(attachments), 'utf-8');
  } catch {
    // Non-fatal attachment cache error
  }
}

function loadJobAttachments(jobId: string): ServerAttachmentPayload[] {
  try {
    const filePath = path.join(ATT_CACHE_DIR, `${jobId}.json`);
    if (fs.existsSync(filePath)) {
      return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as ServerAttachmentPayload[];
    }
  } catch {
    // Ignore
  }
  return [];
}

function appendJobAttachments(jobId: string, extra: ServerAttachmentPayload[]): ServerAttachmentPayload[] {
  const existing = loadJobAttachments(jobId);
  const merged = [...existing, ...extra];
  saveJobAttachments(jobId, merged);
  return merged;
}

function buildPdfCacheFileName(jobId: string, volumeId?: string): string {
  return volumeId ? `${jobId}__${volumeId}.pdf` : `${jobId}.pdf`;
}

export function getServerPdfPath(jobId: string, volumeId?: string): string | null {
  const pdfPath = path.join(PDF_CACHE_DIR, buildPdfCacheFileName(jobId, volumeId));
  return fs.existsSync(pdfPath) ? pdfPath : null;
}

export function registerDriveToken(
  token: string | null | undefined,
  jobId?: string,
  ownerEmail?: string | null
): void {
  if (!token) return;
  const clean = token.replace(/^Bearer\s+/i, '').trim();
  if (!clean) return;
  if (jobId) {
    jobDriveTokens.set(jobId, clean);
    const job = jobsMap.get(jobId);
    if (job?.ownerEmail) {
      userDriveTokens.set(normalizeEmail(job.ownerEmail), clean);
    }
  }
  if (ownerEmail) {
    userDriveTokens.set(normalizeEmail(ownerEmail), clean);
  }
}

function resolveDriveToken(jobId: string, ownerEmail?: string | null): string | null {
  const direct = jobDriveTokens.get(jobId);
  if (direct) return direct;
  const email = normalizeEmail(ownerEmail || jobsMap.get(jobId)?.ownerEmail);
  if (email && userDriveTokens.has(email)) {
    return userDriveTokens.get(email) || null;
  }
  return null;
}

export function getCachedDriveTokenForUser(ownerEmail?: string | null): string | null {
  const email = normalizeEmail(ownerEmail);
  if (!email) return null;
  return userDriveTokens.get(email) || null;
}

export function listServerJobs(): { jobs: PipelineJob[]; activeJobIds: string[] } {
  const jobs = Array.from(jobsMap.values()).sort((a, b) =>
    b.createdAt.localeCompare(a.createdAt)
  );
  const activeJobIds = Array.from(activeControllers.keys());
  return { jobs, activeJobIds };
}

/**
 * Multi-device account-synced job listing with strict tenant isolation.
 * - Authenticated users see ALL their tasks across PC, tablet, and phone.
 * - Tasks created on the current device prior to sign-in are automatically bound to the user's account.
 */
export function listServerJobsForUser(params: {
  ownerEmail?: string | null;
  clientDeviceId?: string | null;
  includeAllForAdmin?: boolean;
}): { jobs: PipelineJob[]; activeJobIds: string[] } {
  const email = normalizeEmail(params.ownerEmail);
  const deviceId = (params.clientDeviceId || '').trim();

  // Claim anonymous device jobs once the user signs in on that device
  if (email && deviceId) {
    let claimed = false;
    for (const job of jobsMap.values()) {
      if (!job.ownerEmail && job.clientDeviceId === deviceId) {
        job.ownerEmail = email;
        claimed = true;
      }
    }
    if (claimed) {
      persistJobsToDisk();
    }
  }

  const allJobs = Array.from(jobsMap.values()).sort((a, b) =>
    b.createdAt.localeCompare(a.createdAt)
  );

  const visibleJobs = allJobs.filter((j) => {
    if (params.includeAllForAdmin) return true;
    if (email) {
      return (
        normalizeEmail(j.ownerEmail) === email ||
        (Boolean(deviceId) && j.clientDeviceId === deviceId && !j.ownerEmail)
      );
    }
    // Unauthenticated preview: show jobs created on this browser device OR pre-upgrade legacy jobs without clientDeviceId
    if (deviceId && j.clientDeviceId === deviceId) return true;
    if (!j.clientDeviceId) return true;
    return false;
  });

  const visibleIds = new Set(visibleJobs.map((j) => j.id));
  const activeJobIds = Array.from(activeControllers.keys()).filter((id) => visibleIds.has(id));

  return { jobs: visibleJobs, activeJobIds };
}

export function getServerJob(jobId: string): PipelineJob | undefined {
  return jobsMap.get(jobId);
}

export function deleteServerJob(jobId: string): void {
  const ctrl = activeControllers.get(jobId);
  if (ctrl) {
    activeControllers.delete(jobId);
    ctrl.abort();
  }
  jobsMap.delete(jobId);
  jobDriveTokens.delete(jobId);
  try {
    const pdfPath = path.join(PDF_CACHE_DIR, `${jobId}.pdf`);
    if (fs.existsSync(pdfPath)) fs.unlinkSync(pdfPath);
    if (fs.existsSync(PDF_CACHE_DIR)) {
      for (const f of fs.readdirSync(PDF_CACHE_DIR)) {
        if (f.startsWith(`${jobId}__`) && f.endsWith('.pdf')) {
          fs.unlinkSync(path.join(PDF_CACHE_DIR, f));
        }
      }
    }
    const attPath = path.join(ATT_CACHE_DIR, `${jobId}.json`);
    if (fs.existsSync(attPath)) fs.unlinkSync(attPath);
    const jobMediaDir = path.join(MEDIA_CACHE_DIR, path.basename(jobId));
    if (fs.existsSync(jobMediaDir)) {
      fs.rmSync(jobMediaDir, { recursive: true, force: true });
    }
  } catch {
    // Ignore
  }
  persistJobsToDisk();
}

export function cancelServerJob(jobId: string): PipelineJob | null {
  const ctrl = activeControllers.get(jobId);
  if (ctrl) {
    activeControllers.delete(jobId);
    ctrl.abort();
  }
  const existing = jobsMap.get(jobId);
  if (!existing) return null;
  const updated: PipelineJob = {
    ...existing,
    stage: 'cancelled',
    updatedAt: new Date().toISOString(),
  };
  jobsMap.set(jobId, updated);
  persistJobsToDisk();
  return updated;
}

function updateJobState(
  jobId: string,
  updater: (prev: PipelineJob) => PipelineJob,
  flushDisk = true
): PipelineJob | null {
  const current = jobsMap.get(jobId);
  if (!current) return null;
  const rawNext = updater(current);
  const next: PipelineJob = {
    ...rawNext,
    lastHeartbeatAt: new Date().toISOString(),
  };
  jobsMap.set(jobId, next);
  if (flushDisk) {
    persistJobsToDisk();
  }
  return next;
}

function addMeasuredUsageToJob(
  jobId: string,
  response: GenerateContentResponse,
  modelIdUsed = CARBON_MODEL,
  roleSummary?: string,
  generatedImagesDelta = 0
): void {
  const meta = response.usageMetadata;
  const inTok = Number(meta?.promptTokenCount || 0);
  const outTok =
    Number(meta?.candidatesTokenCount || 0) + Number(meta?.thoughtsTokenCount || 0);
  if (inTok <= 0 && outTok <= 0 && generatedImagesDelta <= 0) return;

  const modelEntry = getToolModelEntry(modelIdUsed);

  updateJobState(
    jobId,
    (prev) => {
      const prevBilling: JobBillingSnapshot = prev.billing || {
        billingMode: 'super_admin_free',
        estimatedPages: prev.estimatedPages || 1,
        estimatedTokens: 0,
        upstreamApiCostCny: 0,
        chargedCny: 0,
        grossMarginRate: 0.5,
      };
      const nextIn = (prevBilling.actualInputTokens || 0) + inTok;
      const nextOut = (prevBilling.actualOutputTokens || 0) + outTok;

      const existingBreakdown: ModelUsageStat[] = [...(prev.modelUsageBreakdown || [])];
      const existingIdx = existingBreakdown.findIndex((m) => m.modelId === modelIdUsed);
      if (existingIdx >= 0) {
        const cur = existingBreakdown[existingIdx];
        existingBreakdown[existingIdx] = {
          ...cur,
          calls: cur.calls + 1,
          inputTokens: cur.inputTokens + inTok,
          outputTokens: cur.outputTokens + outTok,
          generatedImages: (cur.generatedImages || 0) + generatedImagesDelta,
        };
      } else {
        existingBreakdown.push({
          modelId: modelIdUsed,
          codeName: modelEntry.codeName,
          calls: 1,
          inputTokens: inTok,
          outputTokens: outTok,
          generatedImages: generatedImagesDelta > 0 ? generatedImagesDelta : undefined,
          roleSummary: roleSummary || modelEntry.workflowStages[0] || modelEntry.bestForSummary,
        });
      }

      const savingsPct = computeMultiModelTokenCostSavingsPct(existingBreakdown);

      return {
        ...prev,
        modelUsageBreakdown: existingBreakdown,
        multiModelTokenCostSavingsPct: savingsPct,
        billing: {
          ...prevBilling,
          actualInputTokens: nextIn,
          actualOutputTokens: nextOut,
          actualTotalTokens: nextIn + nextOut,
        },
      };
    },
    false
  );
}

function getGenAIClient(): GoogleGenAI {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error(
      '未检测到 GEMINI_API_KEY 环境变量。请在 AI Studio 的 Settings > Secrets 面板中检查并关联您的付费 API Key。'
    );
  }
  return new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });
}

export function formatGeminiError(err: unknown): {
  status: number;
  message: string;
  isTransient: boolean;
} {
  const raw = err instanceof Error ? err.message : String(err);
  if (
    raw.includes('PERMISSION_DENIED') ||
    raw.includes('403') ||
    raw.includes('API_KEY_INVALID')
  ) {
    return {
      status: 403,
      message:
        'Gemini API 密钥权限不足或无效 (403/400)。请前往 Settings > Secrets 检查并选择已启用计费的 API Key。',
      isTransient: false,
    };
  }
  if (raw.includes('RESOURCE_EXHAUSTED') || raw.includes('429')) {
    return {
      status: 429,
      message:
        '请求触发速率或配额限制 (429)。如持续出现，请在 Settings > Secrets 确认已绑定付费 API Key，或点击「断点继续」稍后恢复。',
      isTransient: true,
    };
  }
  const isTransient =
    raw.includes('503') ||
    raw.includes('500') ||
    raw.includes('502') ||
    raw.includes('504') ||
    raw.includes('UNAVAILABLE') ||
    raw.includes('DEADLINE_EXCEEDED') ||
    raw.includes('INTERNAL') ||
    raw.includes('fetch failed') ||
    raw.includes('network') ||
    raw.includes('terminated') ||
    raw.includes('ECONNRESET');

  return {
    status: 500,
    message: `执行异常: ${raw}`,
    isTransient,
  };
}

/**
 * Builds multimodal Gemini parts supporting unlimited-size server files (via Gemini Files API),
 * inline images/PDFs/audio, and extracted DOCX/Markdown/LaTeX text.
 */
async function buildAttachmentPartsAsync(
  attachments: ServerAttachmentPayload[] = []
): Promise<Record<string, unknown>[]> {
  const parts: Record<string, unknown>[] = [];

  for (const att of attachments) {
    if (att.serverFileId) {
      try {
        const resolved = await resolveStoredFileToGeminiPart(att.serverFileId);
        if (resolved) {
          parts.push(resolved);
          parts.push({
            text: `[已挂载无体积限制多模态参考文件: ${att.name} (${att.mimeType})]`,
          });
          continue;
        }
      } catch (err) {
        console.warn(`Failed to resolve stored file ${att.serverFileId}:`, err);
      }
    }

    if (att.fileUri) {
      parts.push({
        fileData: {
          fileUri: att.fileUri,
          mimeType: att.mimeType || 'application/pdf',
        },
      });
      parts.push({
        text: `[已附带云端大文件引用: ${att.name}]`,
      });
    } else if (
      (att.kind === 'image' || att.kind === 'pdf' || att.kind === 'audio') &&
      att.base64Data
    ) {
      parts.push({
        inlineData: {
          mimeType:
            att.mimeType ||
            (att.kind === 'pdf'
              ? 'application/pdf'
              : att.kind === 'audio'
                ? 'audio/webm'
                : 'image/png'),
          data: att.base64Data,
        },
      });
      parts.push({
        text: `[已附带多模态参考文件: ${att.name} (${att.mimeType})]`,
      });
    } else if (att.extractedText) {
      parts.push({
        text: `[参考文档附件: ${att.name}]\n\`\`\`\n${att.extractedText.slice(0, 65000)}\n\`\`\``,
      });
    }
  }

  return parts;
}

function buildSupplementalPromptSection(directives: SupplementalDirective[] | undefined): string {
  if (!directives || directives.length === 0) return '';
  const lines = directives.map((d, idx) => {
    const sourceTag = d.source === 'voice' ? '语音录入补充' : '文字补充修正';
    const attNames =
      d.attachmentsMeta.length > 0
        ? `（附带参考文件：${d.attachmentsMeta.map((a) => a.name).join('、')}）`
        : '';
    return `${idx + 1}. [${sourceTag} · ${new Date(d.createdAt).toLocaleTimeString('zh-CN')}]${attNames}：${d.text || '请结合新上传的补充文件完善推导与题目设计。'}`;
  });

  return `\n[用户实时追加的补充与修正指令（最高优先级，必须在当前及后续输出中严格落实）]:\n${lines.join('\n')}\n`;
}

function getAllHistoricalJobsForJobOwner(job: PipelineJob): PipelineJob[] {
  const owner = normalizeEmail(job.ownerEmail);
  return Array.from(jobsMap.values())
    .filter((candidate) => {
      if (owner) {
        return normalizeEmail(candidate.ownerEmail) === owner;
      }
      if (job.clientDeviceId && candidate.clientDeviceId === job.clientDeviceId) {
        return true;
      }
      return !candidate.ownerEmail;
    })
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

/**
 * Automatically detects and scans any URLs / Google Drive / Docs / arXiv / PDF links
 * present in `job.rawUserPrompt` or queued `supplementalDirectives` that haven't been scanned yet,
 * registering fetched cloud files directly into the job's multimodal attachments!
 */
async function ensureJobPromptLinksScanned(jobId: string): Promise<void> {
  const job = jobsMap.get(jobId);
  if (!job) return;

  const allDirectiveTexts = (job.supplementalDirectives || []).map((d) => d.text).join('\n');
  const combinedText = `${job.rawUserPrompt}\n${allDirectiveTexts}`;
  const detected = extractRecognizedLinks(combinedText);
  if (detected.length === 0) return;

  const alreadyScannedUrls = new Set((job.scannedLinks || []).map((l) => l.url));
  const hasUnscanned = detected.some((d) => !alreadyScannedUrls.has(d.url));
  if (!hasUnscanned) return;

  const existingAtts = loadJobAttachments(jobId);
  const existingServerIds = new Set(
    existingAtts.map((a) => a.serverFileId).filter((id): id is string => Boolean(id))
  );
  const token = resolveDriveToken(jobId, job.ownerEmail);

  const { scannedLinks, ingestedAttachments } = await scanAndIngestLinksFromInput({
    rawText: combinedText,
    driveToken: token,
    existingServerFileIds: existingServerIds,
  });

  if (ingestedAttachments.length > 0) {
    appendJobAttachments(jobId, ingestedAttachments);
  }

  const newSummaries: AttachmentSummary[] = ingestedAttachments.map((a, idx) => ({
    id: `scan-att-${Date.now()}-${idx}`,
    name: a.name,
    mimeType: a.mimeType,
    size: a.size || 0,
    kind: a.kind,
    serverFileId: a.serverFileId,
    fileUri: a.fileUri,
  }));

  updateJobState(jobId, (prev) => {
    const mergedLinksMap = new Map<string, ScannedLinkResult>();
    for (const oldLink of prev.scannedLinks || []) {
      mergedLinksMap.set(oldLink.url, oldLink);
    }
    for (const freshLink of scannedLinks) {
      mergedLinksMap.set(freshLink.url, freshLink);
    }
    return {
      ...prev,
      scannedLinks: Array.from(mergedLinksMap.values()),
      attachmentsMeta: [...prev.attachmentsMeta, ...newSummaries],
      updatedAt: new Date().toISOString(),
    };
  });
}

// ============================================================================
// Per-User Personal Google Cloud (Google Drive + Google Cloud Storage) Helpers
// ============================================================================

function escapeDriveQuery(str: string): string {
  return str.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

async function findOrCreateDriveFolderServer(
  accessToken: string,
  folderName: string,
  parentId?: string
): Promise<string> {
  const parentClause = parentId ? ` and '${parentId}' in parents` : '';
  const query = `name = '${escapeDriveQuery(folderName)}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false${parentClause}`;
  const searchUrl = `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(query)}&fields=files(id,name)&pageSize=5`;

  const searchRes = await fetch(searchUrl, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (searchRes.status === 401 || searchRes.status === 403) {
    throw new Error('DRIVE_AUTH_EXPIRED');
  }
  if (!searchRes.ok) {
    throw new Error(`查询用户专属 Google Drive 文件夹失败 (${searchRes.status})`);
  }

  const data = (await searchRes.json()) as { files?: Array<{ id: string }> };
  if (data.files && data.files.length > 0) {
    return data.files[0].id;
  }

  const createRes = await fetch('https://www.googleapis.com/drive/v3/files?fields=id,name', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      name: folderName,
      mimeType: 'application/vnd.google-apps.folder',
      ...(parentId ? { parents: [parentId] } : {}),
    }),
  });

  if (!createRes.ok) {
    throw new Error(`创建 Google Drive 文件夹「${folderName}」失败 (${createRes.status})`);
  }
  const created = (await createRes.json()) as { id: string };
  return created.id;
}

function buildMultipartBody(
  metadata: Record<string, unknown>,
  contentBuffer: Buffer,
  contentMimeType: string
): { body: Uint8Array<ArrayBuffer>; boundary: string } {
  const boundary = `carbon_boundary_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const metaPart = Buffer.from(
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n`,
    'utf-8'
  );
  const mediaHeader = Buffer.from(
    `--${boundary}\r\nContent-Type: ${contentMimeType}\r\n\r\n`,
    'utf-8'
  );
  const footer = Buffer.from(`\r\n--${boundary}--\r\n`, 'utf-8');
  return {
    body: new Uint8Array(Buffer.concat([metaPart, mediaHeader, contentBuffer, footer])),
    boundary,
  };
}

async function upsertDriveFileServer(params: {
  accessToken: string;
  existingFileId?: string;
  fileName: string;
  parentId: string;
  mimeType: string;
  contentBuffer: Buffer;
  description?: string;
}): Promise<{ id: string; webViewLink: string }> {
  const {
    accessToken,
    existingFileId,
    fileName,
    parentId,
    mimeType,
    contentBuffer,
    description,
  } = params;

  let targetFileId = existingFileId;

  if (!targetFileId) {
    const q = `name = '${escapeDriveQuery(fileName)}' and '${parentId}' in parents and trashed = false`;
    const findRes = await fetch(
      `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id,webViewLink)&pageSize=3`,
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );
    if (findRes.ok) {
      const found = (await findRes.json()) as { files?: Array<{ id: string }> };
      if (found.files && found.files.length > 0) {
        targetFileId = found.files[0].id;
      }
    }
  }

  if (targetFileId) {
    const { body, boundary } = buildMultipartBody(
      { name: fileName, mimeType, ...(description ? { description } : {}) },
      contentBuffer,
      mimeType
    );
    const patchRes = await fetch(
      `https://www.googleapis.com/upload/drive/v3/files/${encodeURIComponent(targetFileId)}?uploadType=multipart&fields=id,name,webViewLink`,
      {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': `multipart/related; boundary=${boundary}`,
        },
        body,
      }
    );
    if (patchRes.ok) {
      const updated = (await patchRes.json()) as { id: string; webViewLink?: string };
      return {
        id: updated.id,
        webViewLink: updated.webViewLink || `https://drive.google.com/file/d/${updated.id}/view`,
      };
    }
    if (patchRes.status === 401 || patchRes.status === 403) {
      throw new Error('DRIVE_AUTH_EXPIRED');
    }
  }

  const { body, boundary } = buildMultipartBody(
    {
      name: fileName,
      mimeType,
      parents: [parentId],
      ...(description ? { description } : {}),
    },
    contentBuffer,
    mimeType
  );

  const createRes = await fetch(
    'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,webViewLink',
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': `multipart/related; boundary=${boundary}`,
      },
      body,
    }
  );

  if (createRes.status === 401 || createRes.status === 403) {
    throw new Error('DRIVE_AUTH_EXPIRED');
  }
  if (!createRes.ok) {
    const errTxt = await createRes.text();
    throw new Error(`上传至个人 Google Drive 失败 (${createRes.status}): ${errTxt}`);
  }

  const created = (await createRes.json()) as { id: string; webViewLink?: string };
  return {
    id: created.id,
    webViewLink: created.webViewLink || `https://drive.google.com/file/d/${created.id}/view`,
  };
}

/**
 * Optional upload to the user's own Google Cloud Storage bucket (gs://bucket/...)
 * using the user's own Google OAuth token.
 */
async function uploadBufferToUserGcsBucket(params: {
  accessToken: string;
  bucketName: string;
  gcpProjectId?: string;
  objectName: string;
  mimeType: string;
  contentBuffer: Buffer;
}): Promise<{ gcsObjectUri: string; gcsWebLink: string } | null> {
  const cleanBucket = params.bucketName.trim().replace(/^gs:\/\//i, '').replace(/\/+$/, '');
  if (!cleanBucket) return null;

  const projectQuery = params.gcpProjectId
    ? `&userProject=${encodeURIComponent(params.gcpProjectId.trim())}`
    : '';
  const url = `https://storage.googleapis.com/upload/storage/v1/b/${encodeURIComponent(cleanBucket)}/o?uploadType=media&name=${encodeURIComponent(params.objectName)}${projectQuery}`;

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${params.accessToken}`,
      'Content-Type': params.mimeType,
    },
    body: new Uint8Array(params.contentBuffer),
  });

  if (!res.ok) {
    console.warn(`Optional user GCS bucket upload returned ${res.status}`);
    return null;
  }

  return {
    gcsObjectUri: `gs://${cleanBucket}/${params.objectName}`,
    gcsWebLink: `https://storage.cloud.google.com/${encodeURIComponent(cleanBucket)}/${params.objectName
      .split('/')
      .map(encodeURIComponent)
      .join('/')}`,
  };
}

/**
 * Syncs the live job checkpoint JSON and Markdown draft into THAT SPECIFIC USER'S Google Drive.
 */
async function syncLiveCheckpointToDrive(jobId: string): Promise<void> {
  const job = jobsMap.get(jobId);
  if (!job || !job.autoArchiveDrive) return;

  const token = resolveDriveToken(jobId, job.ownerEmail);
  if (!token) return;

  try {
    const userCloudCfg = getUserCloudConfig(job.ownerEmail);
    const folderSpec = buildDriveArchivePath({
      rootFolder:
        job.plan?.archiveRootFolder || job.customRootFolder || userCloudCfg.driveRootFolder,
      subjectCategory: job.plan?.subjectCategory || '进行中任务',
      mode: job.mode,
    });

    const rootId = await findOrCreateDriveFolderServer(token, folderSpec.root);
    const snapshotFolderId = await findOrCreateDriveFolderServer(
      token,
      SNAPSHOT_FOLDER_NAME,
      rootId
    );

    let leafFolderId = job.driveArchive.folderId;
    if (job.plan) {
      const subjectId = await findOrCreateDriveFolderServer(token, folderSpec.subject, rootId);
      leafFolderId = await findOrCreateDriveFolderServer(token, folderSpec.category, subjectId);
    }

    let draftFileId = job.driveArchive.draftFileId;
    let draftWebViewLink = job.driveArchive.draftWebViewLink;

    if (leafFolderId && job.compiledMarkdown.trim().length > 0) {
      const baseTitle = (job.plan?.suggestedFileName || '学术草稿')
        .replace(/\.pdf$/i, '')
        .slice(0, 50);
      const draftMdContent = `# ${job.plan?.documentTitle || '生成中文档'}\n\n> 状态：${job.stage} · 更新时间：${new Date().toLocaleString('zh-CN')}\n\n${job.compiledMarkdown}`;
      const draftUploaded = await upsertDriveFileServer({
        accessToken: token,
        existingFileId: draftFileId,
        fileName: `${baseTitle}_源稿.md`,
        parentId: leafFolderId,
        mimeType: 'text/markdown; charset=UTF-8',
        contentBuffer: Buffer.from(draftMdContent, 'utf-8'),
        description: 'Carbon Scholar Studio 实时云端同步 Markdown 源稿',
      });
      draftFileId = draftUploaded.id;
      draftWebViewLink = draftUploaded.webViewLink;
    }

    const latestJobSnapshot: PipelineJob = {
      ...(jobsMap.get(jobId) || job),
      driveArchive: {
        ...(jobsMap.get(jobId)?.driveArchive || job.driveArchive),
        folderId: leafFolderId,
        folderPath: folderSpec.fullPath,
        draftFileId,
        draftWebViewLink,
        lastSyncedAt: new Date().toISOString(),
      },
    };

    const ckptUploaded = await upsertDriveFileServer({
      accessToken: token,
      existingFileId: job.driveArchive.checkpointFileId,
      fileName: `${jobId}.carbon-task.json`,
      parentId: snapshotFolderId,
      mimeType: 'application/json; charset=UTF-8',
      contentBuffer: Buffer.from(JSON.stringify(latestJobSnapshot, null, 2), 'utf-8'),
      description: `Carbon Task Checkpoint: ${job.plan?.documentTitle || job.rawUserPrompt.slice(0, 40)}`,
    });

    updateJobState(jobId, (prev) => ({
      ...prev,
      driveArchive: {
        ...prev.driveArchive,
        folderId: leafFolderId || prev.driveArchive.folderId,
        folderPath: folderSpec.fullPath,
        draftFileId: draftFileId || prev.driveArchive.draftFileId,
        draftWebViewLink: draftWebViewLink || prev.driveArchive.draftWebViewLink,
        checkpointFileId: ckptUploaded.id,
        lastSyncedAt: new Date().toISOString(),
      },
    }));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg === 'DRIVE_AUTH_EXPIRED') {
      jobDriveTokens.delete(jobId);
      if (job.ownerEmail) {
        userDriveTokens.delete(normalizeEmail(job.ownerEmail));
      }
    }
  }
}

/**
 * Pulls and restores any .carbon-task.json cloud snapshots stored in the authenticated user's own Google Drive.
 */
export async function syncJobsFromGoogleDrive(
  accessToken: string,
  rootFolderName = 'Carbon 学术归档',
  ownerEmail?: string | null
): Promise<{ syncedCount: number; jobs: PipelineJob[] }> {
  const cleanEmail = normalizeEmail(ownerEmail);
  registerDriveToken(accessToken, undefined, cleanEmail || undefined);

  const folderSpec = buildDriveArchivePath({
    rootFolder: rootFolderName,
    subjectCategory: '综合',
    mode: 'lecture_notes',
  });

  const rootQuery = `name = '${escapeDriveQuery(folderSpec.root)}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`;
  const rootRes = await fetch(
    `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(rootQuery)}&fields=files(id,name)&pageSize=5`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );
  if (rootRes.status === 401 || rootRes.status === 403) {
    throw new Error('Google Drive 授权已过期，请重新点击右上角登录账号。');
  }
  const rootData = (await rootRes.json()) as { files?: Array<{ id: string }> };
  if (!rootData.files || rootData.files.length === 0) {
    return {
      syncedCount: 0,
      jobs: listServerJobsForUser({ ownerEmail: cleanEmail }).jobs,
    };
  }

  const snapQuery = `name = '${escapeDriveQuery(SNAPSHOT_FOLDER_NAME)}' and '${rootData.files[0].id}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`;
  const snapRes = await fetch(
    `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(snapQuery)}&fields=files(id)&pageSize=5`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );
  const snapData = (await snapRes.json()) as { files?: Array<{ id: string }> };
  if (!snapData.files || snapData.files.length === 0) {
    return {
      syncedCount: 0,
      jobs: listServerJobsForUser({ ownerEmail: cleanEmail }).jobs,
    };
  }

  const listFilesQuery = `'${snapData.files[0].id}' in parents and name contains '.carbon-task.json' and trashed = false`;
  const filesRes = await fetch(
    `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(listFilesQuery)}&fields=files(id,name,modifiedTime)&pageSize=50`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );
  const filesData = (await filesRes.json()) as {
    files?: Array<{ id: string; name: string }>;
  };

  let syncedCount = 0;
  for (const f of filesData.files || []) {
    try {
      const contentRes = await fetch(
        `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(f.id)}?alt=media`,
        { headers: { Authorization: `Bearer ${accessToken}` } }
      );
      if (!contentRes.ok) continue;
      const remoteJob = (await contentRes.json()) as PipelineJob;
      if (!remoteJob?.id) continue;

      if (activeControllers.has(remoteJob.id)) continue;

      const localExisting = jobsMap.get(remoteJob.id);
      if (!localExisting || remoteJob.updatedAt > localExisting.updatedAt) {
        const taggedJob: PipelineJob = {
          ...remoteJob,
          ownerEmail: cleanEmail || remoteJob.ownerEmail,
        };
        const sanitizedRemote: PipelineJob = isJobActiveStage(taggedJob.stage)
          ? {
              ...taggedJob,
              stage: 'error',
              failedStage: taggedJob.stage,
              errorMessage:
                '已从您的 Google Cloud 云盘恢复未完结快照，点击「断点继续生成」即可接着完成。',
            }
          : taggedJob;
        jobsMap.set(sanitizedRemote.id, sanitizedRemote);
        syncedCount += 1;
      }
    } catch {
      // Skip malformed file
    }
  }

  if (syncedCount > 0) {
    persistJobsToDisk();
  }
  return {
    syncedCount,
    jobs: listServerJobsForUser({ ownerEmail: cleanEmail }).jobs,
  };
}

// ============================================================================
// Server-Side Standalone A4 Vector PDF Compiler (Zero Browser Required!)
// ============================================================================

function findHeadlessChromiumBinary(): string | null {
  const candidates = [
    process.env.CHROMIUM_PATH,
    '/ms-playwright/chrome-headless-shell-linux64/chrome-headless-shell',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/google-chrome',
  ].filter(Boolean) as string[];

  for (const bin of candidates) {
    if (fs.existsSync(bin)) return bin;
  }
  return null;
}

function escapeHtmlServer(str: string): string {
  return str
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function inlineLocalJobMediaForPdf(jobId: string, html: string): string {
  return html.replace(
    /\/api\/jobs\/([^/"'\s]+)\/media\/([^"'\s>?]+)/g,
    (fullMatch, rawJobId, rawFile) => {
      try {
        const decodedJobId = decodeURIComponent(String(rawJobId || jobId));
        const decodedFile = decodeURIComponent(String(rawFile));
        const resolved = getJobMediaFile(decodedJobId, decodedFile);
        if (!resolved) return fullMatch;
        const buf = fs.readFileSync(resolved.filePath);
        return `data:${resolved.mimeType};base64,${buf.toString('base64')}`;
      } catch {
        return fullMatch;
      }
    }
  );
}

function buildStandaloneAcademicHtml(
  job: PipelineJob,
  targetVolume?: GeneratedVolumeArtifact,
  forceOfflineFonts = false
): string {
  let katexCss = '';
  try {
    const katexCssPath = path.resolve(process.cwd(), 'node_modules/katex/dist/katex.min.css');
    const katexFontsDir = path.resolve(process.cwd(), 'node_modules/katex/dist/fonts');
    if (fs.existsSync(katexCssPath)) {
      const rawCss = fs.readFileSync(katexCssPath, 'utf-8');
      katexCss = rewriteKatexCssLocalFonts(rawCss, katexFontsDir);
    }
  } catch {
    // Ignore
  }

  const colorTheme: ColorPaletteTheme =
    job.colorTheme || job.plan?.colorTheme || 'academic_blue';
  const palette = resolveColorPaletteSpec(colorTheme);
  const totalVolumes = job.outputVolumes?.length || job.plan?.volumes?.length || 1;
  const title = targetVolume?.volumeTitle || job.plan?.documentTitle || '学术课程讲义';
  const subtitle = targetVolume?.subtitle || job.plan?.subtitle || '';
  const courseCode = job.plan?.courseCode || 'CARBON-101';
  const subjectCategory = job.plan?.subjectCategory || '综合课程';
  const baseModeLabel =
    targetVolume?.role === 'solutions_manual'
      ? '例题与习题完整解析专册'
      : targetVolume?.role === 'workbook' || job.mode === 'workbook'
        ? '精编练习题册'
        : '深度扩展课程讲义';
  const modeLabel =
    targetVolume && totalVolumes > 1
      ? `第 ${targetVolume.volumeIndex}/${totalVolumes} 分册 · ${baseModeLabel}`
      : baseModeLabel;
  const dateStr = new Date(job.createdAt).toLocaleDateString('zh-CN');
  const rawMd = targetVolume ? targetVolume.compiledMarkdown : job.compiledMarkdown;
  const useRemoteFonts = shouldUseRemoteGoogleFontsInPdf(rawMd.length, forceOfflineFonts);
  const googleFontsLink = useRemoteFonts
    ? '<link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;600&family=Noto+Sans+SC:wght@400;500;600;700&family=Plus+Jakarta+Sans:wght@400;600;700&display=swap" rel="stylesheet" />'
    : '';
  const resolvedOrientation = detectResolvedPageOrientation({
    explicitOrientation: job.pageOrientation,
    planOrientation: job.plan?.pageOrientation,
    rawPrompt: job.rawUserPrompt,
    directivesTexts: (job.supplementalDirectives || []).map((d) => d.text),
  });
  const isLandscape = resolvedOrientation === 'landscape';

  const bodyHtml = inlineLocalJobMediaForPdf(
    job.id,
    renderAcademicMarkdown(rawMd, colorTheme)
  );

  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <title>${escapeHtmlServer(title)}</title>
  ${googleFontsLink}
  <style>
    ${katexCss}
    @page {
      size: A4 ${resolvedOrientation};
      margin: ${isLandscape ? '13mm 16mm 13mm 16mm' : '18mm 16mm 18mm 16mm'};
    }
    body {
      font-family: "Plus Jakarta Sans", "Noto Sans SC", "Liberation Sans", "DejaVu Sans", "Unifont", -apple-system, BlinkMacSystemFont, sans-serif;
      color: #0f172a;
      background: #ffffff;
      font-size: ${isLandscape ? '15px' : '13.5px'};
      line-height: ${isLandscape ? '1.68' : '1.72'};
      margin: 0;
      padding: 0;
      -webkit-print-color-adjust: exact;
      print-color-adjust: exact;
    }
    .cover-box {
      padding: ${isLandscape ? '18px 24px' : '16px 20px'};
      margin-bottom: 22px;
      background-color: ${palette.coverBgHex};
      border: 1px solid ${palette.coverBorderHex};
      border-radius: 8px;
    }
    .cover-meta {
      font-size: ${isLandscape ? '12px' : '11px'};
      color: ${palette.accentHex};
      margin-bottom: 6px;
      font-weight: 600;
    }
    .cover-title {
      font-size: ${isLandscape ? '24px' : '22px'};
      font-weight: 700;
      color: ${palette.coverTitleHex};
      line-height: 1.32;
      margin-bottom: 6px;
    }
    .cover-sub {
      font-size: ${isLandscape ? '14px' : '13px'};
      color: #475569;
      line-height: 1.5;
    }
    h1 {
      font-size: ${isLandscape ? '21.5px' : '20px'};
      font-weight: 700;
      margin-top: 24px;
      margin-bottom: 10px;
      padding-bottom: 6px;
      border-bottom: 1px solid ${palette.h1BorderHex};
      page-break-after: avoid;
    }
    h2 {
      font-size: ${isLandscape ? '18px' : '16.5px'};
      font-weight: 700;
      margin-top: 20px;
      margin-bottom: 8px;
      page-break-after: avoid;
    }
    h3 {
      font-size: ${isLandscape ? '15.5px' : '14.5px'};
      font-weight: 600;
      margin-top: 16px;
      margin-bottom: 6px;
      page-break-after: avoid;
    }
    p { margin: 0 0 10px 0; color: #1e293b; }
    blockquote {
      margin: 12px 0;
      padding: 12px 16px;
      background: #f8fafc;
      border: 1px solid #e2e8f0;
      border-radius: 8px;
      page-break-inside: avoid;
    }
    pre {
      margin: 12px 0;
      padding: 11px 14px;
      background: #f1f5f9;
      border: 1px solid #e2e8f0;
      border-radius: 6px;
      font-family: "JetBrains Mono", monospace;
      font-size: 12px;
      white-space: pre-wrap;
      page-break-inside: avoid;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      margin: 14px 0;
      font-size: 12.5px;
      page-break-inside: avoid;
    }
    th, td {
      border: 1px solid #cbd5e1;
      padding: 7px 9px;
      text-align: left;
    }
    th {
      background: ${palette.tableHeaderBgHex};
      color: ${palette.tableHeaderTextHex};
      font-weight: 600;
    }
    img {
      max-width: 100%;
      height: auto;
      display: block;
      margin: 0 auto;
    }
    .katex-display {
      margin: 12px 0;
      padding: 8px 10px;
      background: #fcfcfd;
      border: 1px solid #f1f5f9;
      border-radius: 6px;
      page-break-inside: avoid;
    }
  </style>
</head>
<body>
  <div class="cover-box">
    <div class="cover-meta">${escapeHtmlServer(courseCode)} · ${escapeHtmlServer(subjectCategory)} · ${escapeHtmlServer(modeLabel)} · ${escapeHtmlServer(dateStr)}</div>
    <div class="cover-title">${escapeHtmlServer(title)}</div>
    ${subtitle ? `<div class="cover-sub">${escapeHtmlServer(subtitle)}</div>` : ''}
  </div>
  <div class="academic-body">${bodyHtml}</div>
</body>
</html>`;
}

function runHeadlessChromiumPrintToPdf(params: {
  chromiumBin: string;
  tmpHtml: string;
  tmpPdf: string;
  timeoutMs: number;
}): Promise<{ ok: boolean; timedOut: boolean; exitCode: number | null }> {
  return new Promise((resolve) => {
    let settled = false;
    let timedOut = false;

    const child = spawn(
      params.chromiumBin,
      [
        '--headless',
        '--no-sandbox',
        '--disable-gpu',
        '--disable-dev-shm-usage',
        '--disable-software-rasterizer',
        '--disable-extensions',
        '--disable-background-networking',
        '--disable-sync',
        '--disable-default-apps',
        '--mute-audio',
        '--no-first-run',
        '--log-level=3',
        '--no-pdf-header-footer',
        `--print-to-pdf=${params.tmpPdf}`,
        `file://${params.tmpHtml}`,
      ],
      {
        // Isolate child stdio completely so container DBus / inotify / netlink chatter
        // never stalls pipe buffers or pollutes server error logs.
        stdio: ['ignore', 'ignore', 'ignore'],
        env: {
          ...process.env,
          DBUS_SESSION_BUS_ADDRESS: 'disabled:',
          DBUS_SYSTEM_BUS_ADDRESS: 'disabled:',
        },
      }
    );

    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill('SIGKILL');
      } catch {
        // Ignore
      }
    }, params.timeoutMs);

    const finish = (ok: boolean, exitCode: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok, timedOut, exitCode });
    };

    child.on('error', () => finish(false, null));
    child.on('close', (code) => finish(code === 0, code));
  });
}

async function compileServerPdfBuffer(
  job: PipelineJob,
  driveToken: string | null,
  persistLocalCache = true,
  targetVolume?: GeneratedVolumeArtifact
): Promise<Buffer | null> {
  ensureStorageDirs();
  const cacheFileName = buildPdfCacheFileName(job.id, targetVolume?.volumeId);
  const chromiumBin = findHeadlessChromiumBinary();
  const rawMd = targetVolume ? targetVolume.compiledMarkdown : job.compiledMarkdown;

  if (chromiumBin) {
    // Attempt 1 uses remote Google Fonts when document size is moderate; if it times out or
    // encounters a network stall, Attempt 2 retries automatically in pure offline font mode.
    const canRetryOffline = shouldUseRemoteGoogleFontsInPdf(rawMd.length, false);
    const attempts = canRetryOffline ? [false, true] : [true];

    for (const forceOffline of attempts) {
      const html = buildStandaloneAcademicHtml(job, targetVolume, forceOffline);
      const htmlBytes = Buffer.byteLength(html, 'utf-8');
      const timeoutMs = computeHeadlessPdfTimeoutMs(htmlBytes);
      const uniqueSuffix = `${job.id}_${targetVolume?.volumeId || 'full'}_${Date.now()}`;
      const tmpHtml = path.join(os.tmpdir(), `carbon_${uniqueSuffix}.html`);
      const tmpPdf = path.join(os.tmpdir(), `carbon_${uniqueSuffix}.pdf`);

      try {
        fs.writeFileSync(tmpHtml, html, 'utf-8');
        await runHeadlessChromiumPrintToPdf({
          chromiumBin,
          tmpHtml,
          tmpPdf,
          timeoutMs,
        });

        if (fs.existsSync(tmpPdf)) {
          const pdfBuf = fs.readFileSync(tmpPdf);
          if (isValidPdfBuffer(pdfBuf)) {
            if (persistLocalCache) {
              fs.writeFileSync(path.join(PDF_CACHE_DIR, cacheFileName), pdfBuf);
            }
            return pdfBuf;
          }
        }
      } catch {
        // Proceed to offline retry or Drive export fallback cleanly
      } finally {
        try {
          if (fs.existsSync(tmpHtml)) fs.unlinkSync(tmpHtml);
          if (fs.existsSync(tmpPdf)) fs.unlinkSync(tmpPdf);
        } catch {
          // Ignore
        }
      }
    }

    console.info(
      `[PDF Compiler] Switching to secondary export path for ${job.id} (${targetVolume?.volumeId || 'full'})`
    );
  }

  const fallbackHtml = buildStandaloneAcademicHtml(job, targetVolume, true);

  if (driveToken) {
    try {
      const { body, boundary } = buildMultipartBody(
        {
          name: `_temp_pdf_render_${job.id}_${targetVolume?.volumeId || 'full'}`,
          mimeType: 'application/vnd.google-apps.document',
        },
        Buffer.from(fallbackHtml, 'utf-8'),
        'text/html; charset=UTF-8'
      );
      const importRes = await fetch(
        'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id',
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${driveToken}`,
            'Content-Type': `multipart/related; boundary=${boundary}`,
          },
          body,
        }
      );
      if (importRes.ok) {
        const tempDoc = (await importRes.json()) as { id: string };
        try {
          const exportRes = await fetch(
            `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(tempDoc.id)}/export?mimeType=application/pdf`,
            { headers: { Authorization: `Bearer ${driveToken}` } }
          );
          if (exportRes.ok) {
            const arrBuf = await exportRes.arrayBuffer();
            const pdfBuf = Buffer.from(arrBuf);
            if (persistLocalCache) {
              fs.writeFileSync(path.join(PDF_CACHE_DIR, cacheFileName), pdfBuf);
            }
            return pdfBuf;
          }
        } finally {
          await fetch(
            `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(tempDoc.id)}`,
            {
              method: 'DELETE',
              headers: { Authorization: `Bearer ${driveToken}` },
            }
          ).catch(() => {});
        }
      }
    } catch (err) {
      console.warn('Drive cloud PDF export fallback warning:', err);
    }
  }

  return null;
}

/**
 * Fetches or compiles PDF bytes ONLY when the user explicitly clicks Download.
 * Supports downloading either the full single document OR any independent volume (`volumeId`)!
 */
export async function streamOrCompileJobPdfOnDemand(
  jobId: string,
  explicitToken?: string,
  volumeId?: string
): Promise<Buffer | null> {
  const job = jobsMap.get(jobId);
  if (!job) return null;

  const token = explicitToken || resolveDriveToken(jobId, job.ownerEmail);
  const cloudCfg = getUserCloudConfig(job.ownerEmail);

  if (volumeId) {
    const targetVol = job.outputVolumes?.find((v) => v.volumeId === volumeId);
    if (!targetVol || !targetVol.compiledMarkdown.trim()) {
      return null;
    }

    if (targetVol.driveFileId && token) {
      try {
        const driveRes = await fetch(
          `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(targetVol.driveFileId)}?alt=media`,
          { headers: { Authorization: `Bearer ${token}` } }
        );
        if (driveRes.ok) {
          const ab = await driveRes.arrayBuffer();
          return Buffer.from(ab);
        }
      } catch {
        // Fall through to cache / compile
      }
    }

    const volCachePath = getServerPdfPath(jobId, volumeId);
    if (volCachePath) {
      return fs.readFileSync(volCachePath);
    }

    return compileServerPdfBuffer(job, token, !cloudCfg.downloadOnDemandOnly, targetVol);
  }

  // 1. If hosted in user's personal Google Drive (single-file mode), pull directly from user's cloud on demand!
  if (job.driveArchive.fileId && token) {
    try {
      const driveRes = await fetch(
        `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(job.driveArchive.fileId)}?alt=media`,
        { headers: { Authorization: `Bearer ${token}` } }
      );
      if (driveRes.ok) {
        const ab = await driveRes.arrayBuffer();
        return Buffer.from(ab);
      }
    } catch {
      // Fall through to local/on-demand compile
    }
  }

  // 2. Check server disk cache
  const localPath = getServerPdfPath(jobId);
  if (localPath) {
    return fs.readFileSync(localPath);
  }

  // 3. Compile fresh on-demand
  if (job.compiledMarkdown.trim().length > 0) {
    return compileServerPdfBuffer(job, token, !cloudCfg.downloadOnDemandOnly);
  }

  return null;
}

/**
 * Compiles PDF(s) and uploads directly into the USER'S OWN Google Cloud (Google Drive + optional GCS bucket).
 * When multi-volume output (`outputVolumes.length > 1`) is active, creates a dedicated book-set folder
 * and uploads EVERY independent volume PDF file cleanly!
 */
export async function archiveServerJobToDrive(
  jobId: string,
  explicitToken?: string
): Promise<PipelineJob> {
  const job = jobsMap.get(jobId);
  if (!job) {
    throw new Error('找不到指定的任务记录');
  }
  if (explicitToken) {
    registerDriveToken(explicitToken, jobId, job.ownerEmail);
  }
  const token = resolveDriveToken(jobId, job.ownerEmail);
  if (!token) {
    throw new Error('尚未连接您的个人 Google Cloud / Drive 授权，请先登录账号。');
  }

  const userCloudCfg = getUserCloudConfig(job.ownerEmail);

  updateJobState(jobId, (prev) => ({
    ...prev,
    driveArchive: {
      ...prev.driveArchive,
      status: 'uploading',
      error: undefined,
    },
  }));

  const folderSpec = buildDriveArchivePath({
    rootFolder:
      job.plan?.archiveRootFolder || job.customRootFolder || userCloudCfg.driveRootFolder,
    subjectCategory: job.plan?.subjectCategory,
    mode: job.mode,
  });

  const rootId = await findOrCreateDriveFolderServer(token, folderSpec.root);
  const subjectId = await findOrCreateDriveFolderServer(token, folderSpec.subject, rootId);
  const leafId = await findOrCreateDriveFolderServer(token, folderSpec.category, subjectId);

  const nonEmptyVolumes = (job.outputVolumes || []).filter(
    (v) => v.compiledMarkdown.trim().length > 0
  );
  const isMultiVolJob =
    (job.outputVolumes?.length || 0) > 1 && nonEmptyVolumes.length > 0;

  if (isMultiVolJob) {
    const setFolderName = sanitizeFolderSegment(
      job.plan?.documentTitle || '分册独立讲义合集',
      '分册独立讲义合集'
    );
    const setFolderId = await findOrCreateDriveFolderServer(token, setFolderName, leafId);
    const fullSetFolderPath = `${folderSpec.fullPath} / ${setFolderName}`;

    const updatedVolumes: GeneratedVolumeArtifact[] = [];
    let firstUploadedPdfId: string | undefined;
    let firstGcsResult: { gcsObjectUri: string; gcsWebLink: string } | null = null;

    for (const vol of job.outputVolumes || []) {
      if (!vol.compiledMarkdown.trim()) {
        updatedVolumes.push(vol);
        continue;
      }

      const cachedVolPath = getServerPdfPath(jobId, vol.volumeId);
      const volPdfBuffer = cachedVolPath
        ? fs.readFileSync(cachedVolPath)
        : await compileServerPdfBuffer(job, token, !userCloudCfg.downloadOnDemandOnly, vol);

      if (!volPdfBuffer) {
        throw new Error(`分册《${vol.volumeTitle}》PDF 编译暂不可用，请重试。`);
      }

      const uploadedVolPdf = await upsertDriveFileServer({
        accessToken: token,
        existingFileId: vol.driveFileId,
        fileName: vol.fileName,
        parentId: setFolderId,
        mimeType: 'application/pdf',
        contentBuffer: volPdfBuffer,
        description: `${vol.volumeTitle} — ${vol.subtitle || ''}`,
      });

      if (!firstUploadedPdfId) {
        firstUploadedPdfId = uploadedVolPdf.id;
      }

      let volGcs: { gcsObjectUri: string; gcsWebLink: string } | null = null;
      if (
        userCloudCfg.mode === 'google_cloud_storage_and_drive' &&
        userCloudCfg.gcsBucketName.trim()
      ) {
        const gcsObjPath = `${folderSpec.subject}/${folderSpec.category}/${setFolderName}/${vol.fileName}`;
        volGcs = await uploadBufferToUserGcsBucket({
          accessToken: token,
          bucketName: userCloudCfg.gcsBucketName,
          gcpProjectId: userCloudCfg.gcpProjectId,
          objectName: gcsObjPath,
          mimeType: 'application/pdf',
          contentBuffer: volPdfBuffer,
        });
        if (volGcs && !firstGcsResult) {
          firstGcsResult = volGcs;
        }
      }

      if (userCloudCfg.downloadOnDemandOnly && uploadedVolPdf.id) {
        try {
          const localVolFile = path.join(
            PDF_CACHE_DIR,
            buildPdfCacheFileName(jobId, vol.volumeId)
          );
          if (fs.existsSync(localVolFile)) fs.unlinkSync(localVolFile);
        } catch {
          // Ignore
        }
      }

      updatedVolumes.push({
        ...vol,
        status: 'completed',
        serverPdfReady: true,
        driveFileId: uploadedVolPdf.id,
        driveWebViewLink: uploadedVolPdf.webViewLink,
        gcsObjectUri: volGcs?.gcsObjectUri || vol.gcsObjectUri,
        gcsWebLink: volGcs?.gcsWebLink || vol.gcsWebLink,
      });
    }

    const folderWebLink = `https://drive.google.com/drive/folders/${setFolderId}`;
    const finishedMulti = updateJobState(jobId, (prev) => ({
      ...prev,
      serverPdfReady: true,
      cloudOnlyHosted: Boolean(userCloudCfg.downloadOnDemandOnly && firstUploadedPdfId),
      outputVolumes: updatedVolumes,
      updatedAt: new Date().toISOString(),
      driveArchive: {
        ...prev.driveArchive,
        status: 'archived',
        folderId: setFolderId,
        folderPath: fullSetFolderPath,
        fileId: firstUploadedPdfId || prev.driveArchive.fileId,
        webViewLink: folderWebLink,
        gcsObjectUri: firstGcsResult?.gcsObjectUri || prev.driveArchive.gcsObjectUri,
        gcsWebLink: firstGcsResult?.gcsWebLink || prev.driveArchive.gcsWebLink,
        archivedAt: new Date().toISOString(),
        error: undefined,
      },
    }))!;

    await syncLiveCheckpointToDrive(jobId);
    return finishedMulti;
  }

  // Single-file PDF archive path
  const existingPdfPath = getServerPdfPath(jobId);
  const pdfBuffer = existingPdfPath
    ? fs.readFileSync(existingPdfPath)
    : await compileServerPdfBuffer(job, token, !userCloudCfg.downloadOnDemandOnly);

  if (!pdfBuffer) {
    throw new Error('服务端生成 PDF 暂不可用，请点击下载按钮触发按需导出。');
  }

  const pdfFileName = normalizePdfFileName(
    job.plan?.suggestedFileName || `${job.plan?.documentTitle || '学术文档'}.pdf`,
    job.mode
  );

  const uploadedPdf = await upsertDriveFileServer({
    accessToken: token,
    existingFileId: job.driveArchive.fileId,
    fileName: pdfFileName,
    parentId: leafId,
    mimeType: 'application/pdf',
    contentBuffer: pdfBuffer,
    description: job.plan?.subtitle || job.rawUserPrompt,
  });

  let gcsResult: { gcsObjectUri: string; gcsWebLink: string } | null = null;
  if (
    userCloudCfg.mode === 'google_cloud_storage_and_drive' &&
    userCloudCfg.gcsBucketName.trim()
  ) {
    const gcsObjectPath = `${folderSpec.subject}/${folderSpec.category}/${pdfFileName}`;
    gcsResult = await uploadBufferToUserGcsBucket({
      accessToken: token,
      bucketName: userCloudCfg.gcsBucketName,
      gcpProjectId: userCloudCfg.gcpProjectId,
      objectName: gcsObjectPath,
      mimeType: 'application/pdf',
      contentBuffer: pdfBuffer,
    });
  }

  let cloudOnlyHosted = false;
  if (userCloudCfg.downloadOnDemandOnly && uploadedPdf.id) {
    cloudOnlyHosted = true;
    try {
      const localPdf = path.join(PDF_CACHE_DIR, `${jobId}.pdf`);
      if (fs.existsSync(localPdf)) {
        fs.unlinkSync(localPdf);
      }
    } catch {
      // Ignore
    }
  }

  const finished = updateJobState(jobId, (prev) => ({
    ...prev,
    serverPdfReady: true,
    cloudOnlyHosted,
    outputVolumes: prev.outputVolumes?.map((v, idx) =>
      idx === 0
        ? {
            ...v,
            status: 'completed',
            serverPdfReady: true,
            driveFileId: uploadedPdf.id,
            driveWebViewLink: uploadedPdf.webViewLink,
          }
        : v
    ),
    updatedAt: new Date().toISOString(),
    driveArchive: {
      ...prev.driveArchive,
      status: 'archived',
      folderId: leafId,
      folderPath: folderSpec.fullPath,
      fileId: uploadedPdf.id,
      webViewLink: uploadedPdf.webViewLink,
      gcsObjectUri: gcsResult?.gcsObjectUri || prev.driveArchive.gcsObjectUri,
      gcsWebLink: gcsResult?.gcsWebLink || prev.driveArchive.gcsWebLink,
      archivedAt: new Date().toISOString(),
      error: undefined,
    },
  }))!;

  await syncLiveCheckpointToDrive(jobId);
  return finished;
}

// ============================================================================
// Live Mid-Execution Supplemental Requirement Synthesis & Dynamic Workflow Replanning
// ============================================================================

/**
 * Dynamically consolidates newly queued supplemental directives into:
 * 1. `job.consolidatedRequirements` (deduplicating & resolving conflicting instructions)
 * 2. Remaining `pending` batches and `volumes` via a fast `ThinkingLevel.LOW` delta synthesis pass
 *    on `gemini-4-carbon`, WITHOUT interrupting any currently streaming batch!
 */
async function reconcileQueuedSupplementsIntoWorkflowServer(
  jobId: string,
  currentBatchIdx: number
): Promise<void> {
  const job = jobsMap.get(jobId);
  if (!job || !job.plan) return;

  const directives = job.supplementalDirectives || [];
  const queued = directives.filter((d) => d.status === 'queued');
  if (queued.length === 0) return;

  // Step 1: Deterministic conflict-resolved requirement consolidation
  const consolidated = consolidateRequirementsPure({
    rawUserPrompt: job.rawUserPrompt,
    directives,
    scannedLinks: job.scannedLinks,
    volumeSplitMode: job.volumeSplitMode,
    previousVersion: job.consolidatedRequirements?.version || 0,
  });

  const splitIntent = detectMultiVolumeIntent({
    rawPrompt: job.rawUserPrompt,
    directives,
    explicitMode: job.volumeSplitMode,
  });

  updateJobState(jobId, (prev) => ({
    ...prev,
    consolidatedRequirements: consolidated,
  }));

  // Step 2: Fast LLM delta workflow check (`ThinkingLevel.LOW`) to adjust pending rounds or add new volumes/rounds if needed!
  try {
    const ai = getGenAIClient();
    const singleCallWords = SINGLE_CALL_TARGET_WORDS_BY_DEPTH[job.depth];
    const completedOrRunningBatches = job.plan.batches.slice(0, currentBatchIdx);
    const pendingBatches = job.plan.batches.slice(currentBatchIdx);

    const deltaPrompt = `[当前文档总标题]: ${job.plan.documentTitle} (${job.plan.courseCode})
[整合后的全局需求规范 (v${consolidated.version})]:
${consolidated.synthesizedMasterBrief}
[最新待跟进的补充指令 (${queued.length} 条)]:
${queued.map((q, idx) => `${idx + 1}. ${q.text || '结合新增补充附件扩展'}`).join('\n')}
[分册意图自动检测]: ${splitIntent.shouldSplitVolumes ? `需要分册输出 (${splitIntent.reasonSummary})` : '无需强制新增分册'}
[当前已有输出分册 (${job.plan.volumes?.length || 1} 册)]:
${(job.plan.volumes || []).map((v) => `- ${v.volumeId}: 《${v.volumeTitle}》(${v.role})`).join('\n') || '- vol-1: 主文档'}
[已完成或正在执行的模块 (${completedOrRunningBatches.length} 个，不可修改)]:
${completedOrRunningBatches.map((b) => `- 第 ${b.batchIndex} 模块: 《${b.title}》(${b.volumeId || 'vol-1'})`).join('\n') || '尚无已完成模块'}
[尚未执行的待办模块 (${pendingBatches.length} 个，可优化合并、调整范围或增补新模块)]:
${pendingBatches.map((b) => `- 《${b.title}》(${b.volumeId || 'vol-1'}): ${b.sections.join('、')}`).join('\n') || '当前无剩余待办模块'}

请根据最新补充指令，精炼更新后的《全局执行规范摘要》(refinedMasterBrief)，并输出更新后的【剩余待执行模块列表】(updatedPendingBatches，每个模块控制在质量甜点约 ${singleCallWords} 字，优先保证推导与排版质量，最后统一无缝拼接；并可为每个模块指定最适配专精模型 assignedModelId：gemini-4-carbon / gemini-4-argon / gemini-4-hydrogen / gemini-3.1-flash-lite)，以及可选的【新增独立分册】(additionalVolumes)。`;

    const resp = await ai.models.generateContent({
      model: CARBON_MODEL,
      contents: deltaPrompt,
      config: {
        systemInstruction:
          '你是基于 Gemini 4 Carbon 的多模型协同动态重编排引擎。你的职责是在不打断已完成工作的前提下，将用户的新增要求无损整合进剩余模块、专精模型分工与独立分册配置中，最大化 Token 效率与输出质量。',
        thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
        responseMimeType: 'application/json',
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            refinedMasterBrief: { type: Type.STRING },
            additionalVolumes: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                properties: {
                  volumeTitle: { type: Type.STRING },
                  subtitle: { type: Type.STRING },
                  suggestedFileName: { type: Type.STRING },
                  role: { type: Type.STRING },
                  scopeSummary: { type: Type.STRING },
                },
                required: ['volumeTitle', 'subtitle', 'suggestedFileName', 'role', 'scopeSummary'],
              },
            },
            updatedPendingBatches: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                properties: {
                  title: { type: Type.STRING },
                  scopeSummary: { type: Type.STRING },
                  sections: { type: Type.ARRAY, items: { type: Type.STRING } },
                  estimatedPages: { type: Type.INTEGER },
                  targetWords: { type: Type.INTEGER },
                  includeAnswerKey: { type: Type.BOOLEAN },
                  volumeId: { type: Type.STRING },
                  assignedModelId: { type: Type.STRING },
                  dispatchReason: { type: Type.STRING },
                },
                required: [
                  'title',
                  'scopeSummary',
                  'sections',
                  'estimatedPages',
                  'targetWords',
                  'includeAnswerKey',
                ],
              },
            },
          },
          required: ['refinedMasterBrief', 'updatedPendingBatches'],
        },
      },
    });

    addMeasuredUsageToJob(jobId, resp, CARBON_MODEL, '动态需求整合与多模型重编排');
    const raw = (resp.text ?? '{}').trim();
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    const parsed = JSON.parse(jsonMatch ? jsonMatch[0] : raw) as {
      refinedMasterBrief?: string;
      additionalVolumes?: Array<Record<string, unknown>>;
      updatedPendingBatches?: Array<Record<string, unknown>>;
    };

    updateJobState(jobId, (prev) => {
      if (!prev.plan) return prev;
      const existingVols: OutputVolumeSpec[] =
        prev.plan.volumes && prev.plan.volumes.length > 0
          ? [...prev.plan.volumes]
          : [
              {
                volumeId: 'vol-1',
                volumeIndex: 1,
                volumeTitle: prev.plan.documentTitle,
                subtitle: prev.plan.subtitle,
                suggestedFileName: prev.plan.suggestedFileName,
                role: prev.mode === 'workbook' ? 'workbook' : 'main_lecture',
                scopeSummary: prev.plan.expandedPrompt,
              },
            ];

      if (Array.isArray(parsed.additionalVolumes) && parsed.additionalVolumes.length > 0) {
        for (const av of parsed.additionalVolumes) {
          const nextVolIdx = existingVols.length + 1;
          const nextVolId = `vol-${nextVolIdx}`;
          const rawRole = String(av.role || '');
          const validRole: VolumeRole =
            rawRole === 'solutions_manual' ||
            rawRole === 'chapter_volume' ||
            rawRole === 'workbook' ||
            rawRole === 'main_lecture' ||
            rawRole === 'supplement_volume'
              ? rawRole
              : 'supplement_volume';
          existingVols.push({
            volumeId: nextVolId,
            volumeIndex: nextVolIdx,
            volumeTitle: String(av.volumeTitle || `${prev.plan.documentTitle} · 第 ${nextVolIdx} 分册`),
            subtitle: String(av.subtitle || prev.plan.subtitle),
            suggestedFileName: normalizePdfFileName(
              String(av.suggestedFileName || `${prev.plan.courseCode}_第${nextVolIdx}分册.pdf`),
              validRole === 'workbook' || validRole === 'solutions_manual' ? 'workbook' : prev.mode
            ),
            role: validRole,
            scopeSummary: String(av.scopeSummary || ''),
          });
        }
      }

      const volMap = new Map(existingVols.map((v) => [v.volumeId, v]));
      const lockedPlanBatches = prev.plan.batches.slice(0, currentBatchIdx);
      const lockedStateBatches = prev.batches.slice(0, currentBatchIdx);

      const rawUpdatedPending = Array.isArray(parsed.updatedPendingBatches)
        ? parsed.updatedPendingBatches
        : [];
      const totalPlannedCount = lockedPlanBatches.length + rawUpdatedPending.length;

      const nextPendingSpecs: TaskBatchSpec[] =
        rawUpdatedPending.length > 0
          ? rawUpdatedPending.map((pb, idx) => {
              const bNum = lockedPlanBatches.length + idx + 1;
              const requestedVolId = pb.volumeId ? String(pb.volumeId) : '';
              const resolvedVol =
                volMap.get(requestedVolId) || existingVols[existingVols.length - 1];
              const bTitle = String(pb.title || `第 ${bNum} 模块动态整合精编`);
              const bScope = String(pb.scopeSummary || '');
              const bSections =
                Array.isArray(pb.sections) && pb.sections.length > 0
                  ? pb.sections.map(String)
                  : ['补充与整合章节展开'];
              const routed = routeSpecialistModelForBatch({
                batchIndex: bNum,
                totalBatches: totalPlannedCount,
                title: bTitle,
                scopeSummary: bScope,
                sections: bSections,
                mode: prev.mode,
                volumeRole: resolvedVol.role,
                requestedModelId: pb.assignedModelId ? String(pb.assignedModelId) : undefined,
                requestedReason: pb.dispatchReason ? String(pb.dispatchReason) : undefined,
              });
              const clampedWords = clampModuleWordsToQualitySweetSpot(
                Number(pb.targetWords) || singleCallWords,
                prev.depth
              );
              return {
                batchIndex: bNum,
                title: bTitle,
                scopeSummary: bScope,
                sections: bSections,
                estimatedPages: Math.max(4, Math.ceil(clampedWords / 650)),
                targetWords: clampedWords,
                includeAnswerKey: Boolean(
                  pb.includeAnswerKey ?? (resolvedVol.role === 'solutions_manual' || prev.mode === 'workbook')
                ),
                volumeId: resolvedVol.volumeId,
                volumeIndex: resolvedVol.volumeIndex,
                assignedModelId: routed.assignedModelId,
                specialistRole: routed.specialistRole,
                dispatchReason: routed.dispatchReason,
                isSupplementalBatch: idx >= pendingBatches.length,
              };
            })
          : prev.plan.batches.slice(currentBatchIdx);

      const nextPendingStates: BatchExecutionState[] = nextPendingSpecs.map((spec) => ({
        batchIndex: spec.batchIndex,
        title: spec.title,
        volumeId: spec.volumeId,
        volumeIndex: spec.volumeIndex,
        modelUsed: spec.assignedModelId,
        status: 'pending',
        continuationCount: 0,
        autoRetryCount: 0,
        markdownContent: '',
      }));

      const nextPlan: ExpandedPlan = {
        ...prev.plan,
        isMultiVolume: existingVols.length > 1,
        volumes: existingVols,
        batches: [...lockedPlanBatches, ...nextPendingSpecs],
      };

      const nextBatches = [...lockedStateBatches, ...nextPendingStates];
      const nextConsolidated = {
        ...(prev.consolidatedRequirements || consolidated),
        synthesizedMasterBrief:
          parsed.refinedMasterBrief?.trim() || consolidated.synthesizedMasterBrief,
      };

      return {
        ...prev,
        plan: nextPlan,
        batches: nextBatches,
        consolidatedRequirements: nextConsolidated,
        outputVolumes: computeVolumeArtifactsFromBatches({
          plan: nextPlan,
          batches: nextBatches,
          existingVolumes: prev.outputVolumes,
          defaultMode: prev.mode,
          jobStage: prev.stage,
        }),
        supplementalDirectives: (prev.supplementalDirectives || []).map((d) =>
          d.status === 'queued'
            ? {
                ...d,
                status: 'applied',
                appliedBatchIndex: currentBatchIdx + 1,
              }
            : d
        ),
        updatedAt: new Date().toISOString(),
      };
    });
  } catch (err) {
    console.warn('Dynamic supplement workflow delta warning (falling back to pure consolidation):', err);
    updateJobState(jobId, (prev) => ({
      ...prev,
      supplementalDirectives: (prev.supplementalDirectives || []).map((d) =>
        d.status === 'queued'
          ? { ...d, status: 'applied', appliedBatchIndex: currentBatchIdx + 1 }
          : d
      ),
    }));
  }
}

export function appendSupplementalDirectiveToJob(params: {
  jobId: string;
  text: string;
  source: 'text' | 'voice';
  attachments: ServerAttachmentPayload[];
  driveToken?: string;
  ownerEmail?: string | null;
}): PipelineJob {
  const job = jobsMap.get(params.jobId);
  if (!job) {
    throw new Error('未找到对应的任务，无法追加补充要求');
  }

  if (params.driveToken) {
    registerDriveToken(params.driveToken, params.jobId, params.ownerEmail || job.ownerEmail);
  }

  const newAttSummaries: AttachmentSummary[] = params.attachments.map((a, idx) => ({
    id: `supp-att-${Date.now()}-${idx}`,
    name: a.name,
    mimeType: a.mimeType,
    size:
      a.size ||
      (a.base64Data ? Math.round((a.base64Data.length * 3) / 4) : (a.extractedText || '').length),
    kind: a.kind,
    serverFileId: a.serverFileId,
    fileUri: a.fileUri,
  }));

  if (params.attachments.length > 0) {
    appendJobAttachments(params.jobId, params.attachments);
  }

  const directive: SupplementalDirective = {
    id: `dir-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    createdAt: new Date().toISOString(),
    text: params.text.trim(),
    source: params.source,
    attachmentsMeta: newAttSummaries,
    status: 'queued',
  };

  const nextDirectives = [...(job.supplementalDirectives || []), directive];
  const immediateConsolidated = consolidateRequirementsPure({
    rawUserPrompt: job.rawUserPrompt,
    directives: nextDirectives,
    scannedLinks: job.scannedLinks,
    volumeSplitMode: job.volumeSplitMode,
    previousVersion: job.consolidatedRequirements?.version || 0,
  });

  const isCurrentlyRunningOnServer = activeControllers.has(params.jobId);
  const allExistingBatchesDone =
    job.plan !== null &&
    job.batches.length > 0 &&
    job.batches.every((b) => b.status === 'completed');

  let updatedPlan = job.plan;
  let updatedBatches = [...job.batches];

  if (!isCurrentlyRunningOnServer && allExistingBatchesDone && updatedPlan) {
    const nextIdx = updatedPlan.batches.length + 1;
    const singleCallWords = SINGLE_CALL_TARGET_WORDS_BY_DEPTH[job.depth];
    const lastVol = updatedPlan.volumes?.[updatedPlan.volumes.length - 1];
    const suppSections = ['补充要求专项展开与推导', '新增资料融合解析与修正补遗'];
    const routed = routeSpecialistModelForBatch({
      batchIndex: nextIdx,
      totalBatches: nextIdx,
      title: `补充与修正增补模块（第 ${nextIdx} 模块）`,
      scopeSummary: directive.text,
      sections: suppSections,
      mode: job.mode,
      volumeRole: lastVol?.role,
    });
    const suppSpec: TaskBatchSpec = {
      batchIndex: nextIdx,
      title: `补充与修正增补模块（第 ${nextIdx} 模块）`,
      scopeSummary: directive.text || '结合新增补充要求与上传附件进行深度增补与修正完善',
      sections: suppSections,
      estimatedPages: Math.max(4, Math.ceil(singleCallWords / 650)),
      targetWords: singleCallWords,
      includeAnswerKey: job.mode === 'workbook',
      volumeId: lastVol?.volumeId || 'vol-1',
      volumeIndex: lastVol?.volumeIndex || 1,
      assignedModelId: routed.assignedModelId,
      specialistRole: routed.specialistRole,
      dispatchReason: routed.dispatchReason,
      isSupplementalBatch: true,
    };
    updatedPlan = {
      ...updatedPlan,
      batches: [...updatedPlan.batches, suppSpec],
    };
    updatedBatches = [
      ...updatedBatches,
      {
        batchIndex: nextIdx,
        title: suppSpec.title,
        volumeId: suppSpec.volumeId,
        volumeIndex: suppSpec.volumeIndex,
        modelUsed: suppSpec.assignedModelId,
        status: 'pending',
        continuationCount: 0,
        autoRetryCount: 0,
        markdownContent: '',
      },
    ];
  }

  const updated = updateJobState(params.jobId, (prev) => ({
    ...prev,
    updatedAt: new Date().toISOString(),
    isStitchedAndPolished: false,
    plan: updatedPlan || prev.plan,
    batches: updatedBatches.length > prev.batches.length ? updatedBatches : prev.batches,
    attachmentsMeta: [...prev.attachmentsMeta, ...newAttSummaries],
    supplementalDirectives: nextDirectives,
    consolidatedRequirements: immediateConsolidated,
  }))!;

  if (extractRecognizedLinks(directive.text).length > 0) {
    void ensureJobPromptLinksScanned(params.jobId).catch(() => {});
  }

  if (!isCurrentlyRunningOnServer) {
    return resumeDetachedJob({
      incomingJob: updated,
      strategy: 'continue',
      driveToken: params.driveToken,
      ownerEmail: params.ownerEmail || updated.ownerEmail,
    });
  }

  return updated;
}

// ============================================================================
// Detached Background Pipeline Execution Engine
// ============================================================================

async function generateExpandedPlanServer(params: {
  jobId: string;
  mode: DocMode;
  depth: DepthPreset;
  rawUserPrompt: string;
  customRootFolder: string;
  attachments: ServerAttachmentPayload[];
  signal: AbortSignal;
}): Promise<ExpandedPlan> {
  const ai = getGenAIClient();
  const attachmentParts = await buildAttachmentPartsAsync(params.attachments);
  const currentJobSnapshot = jobsMap.get(params.jobId);
  const liveDirectives = currentJobSnapshot?.supplementalDirectives || [];
  const volumeSplitMode: VolumeSplitMode = currentJobSnapshot?.volumeSplitMode || 'auto';
  const colorTheme: ColorPaletteTheme = currentJobSnapshot?.colorTheme || 'academic_blue';
  const autoGenerateFigures = currentJobSnapshot?.autoGenerateFigures ?? true;
  const palette = resolveColorPaletteSpec(colorTheme);

  const consolidated = consolidateRequirementsPure({
    rawUserPrompt: params.rawUserPrompt,
    directives: liveDirectives,
    scannedLinks: currentJobSnapshot?.scannedLinks,
    volumeSplitMode,
    previousVersion: currentJobSnapshot?.consolidatedRequirements?.version || 0,
  });

  updateJobState(params.jobId, (prev) => ({
    ...prev,
    consolidatedRequirements: consolidated,
  }));

  const multiVolumeDetection = detectMultiVolumeIntent({
    rawPrompt: params.rawUserPrompt,
    directives: liveDirectives,
    explicitMode: volumeSplitMode,
  });

  const singleCallTargetWords = SINGLE_CALL_TARGET_WORDS_BY_DEPTH[params.depth];

  const adaptiveRoundGuidance = `【质量优先的适度单次容量 + 动态自适应模块数原则（严禁单次硬顶极限导致质量衰减）】：
- 每个模块（batch）的单次输出目标控制在【质量甜点区间：约 ${singleCallTargetWords.toLocaleString()} 字/词】（绝对不要把单次 targetWords 硬顶到一万多字，避免尾段推理衰减、公式跳步或截断）。
- **绝不固定模块/轮次上限**！为了兼顾最高推导质量与全量覆盖，按课题真实体量需要拆分成多少个高精模块（1..N 模块）就拆分成多少个模块，最后系统会将所有模块与插图无缝整合拼接成完整成书！`;

  const multiModelRoutingGuidance = `【主思考模型 Carbon 多模型工具库按需分配调用规则】：
你（\`gemini-4-carbon\`）作为总设计师，必须在 \`batches\` 中为每个模块指派最适配、最高 Token 性价比的专精模型（\`assignedModelId\`）并写明调度理由（\`dispatchReason\`）：
1. \`gemini-4-carbon\`（主思考与严密证明模型，成本系数 1.00x）：仅分配给公理体系构建、高难度核心定理/压轴题无跳步严密证明板块（\`specialistRole = "orchestration_and_proof"\`）。
2. \`gemini-4-argon\`（数理推导与分级命题专精模型，成本系数 0.62x）：优先分配给典型例题分步演算、分级练习题组设计、一题多解与独立答案详解分册（\`specialistRole = "stem_problem_derivation"\`）。
3. \`gemini-4-hydrogen\`（高吞吐概念阐释与彩色知识框填色排版模型，成本系数 0.28x）：优先分配给背景动机导引、物理/几何直觉阐述、彩色填色知识框（定义框/定理框/警示框）与多维对比表格模块（\`specialistRole = "conceptual_prose_and_color_layout"\`）。
4. \`gemini-3.1-flash-lite\`（极低 Token 速查索引与过渡衔接模型，成本系数 0.10x）：分配给全局符号速查表、附录公式卡或轻量总结索引模块（\`specialistRole = "lean_transition_and_index"\`）。
${
  autoGenerateFigures
    ? `5. **Nano Banana 视觉插图按需调度（\`visualFigures\`）**：对需要几何/物理/机理图解的关键模块（每个模块 0–1 幅高价值插图，最多不超过 2 幅；纯代数推导或答案册可设为空数组），在 \`visualFigures\` 中规划插图描述（英文精细学术绘图提示词 \`prompt\`，适配当前「${palette.label}」白底教材配色）并指派：
   - \`gemini-nano-banana-2.1\`（Nano Banana 2.1 高清科学机理与几何彩色插图引擎）：用于核心定理几何变换图、场线/受力/系统结构主图；
   - \`gemini-3.1-flash-lite-image\`（Nano Banana Lite 快速示意图引擎）：用于例题/习题配套几何简图、状态转移图或实验装置简图。`
    : '5. 用户当前已关闭自动配图，请将所有模块的 `visualFigures` 设为空数组 `[]`。'
}`;

  const multiVolumeGuidance = multiVolumeDetection.shouldSplitVolumes
    ? `【多份独立分册文件输出规则（已激活）】：
- 检测结论：${multiVolumeDetection.reasonSummary}
- 你必须在 \`volumes\` 数组中规划多份独立的输出文件（每份对应一个独立 PDF 文件，如 \`vol-1\`, \`vol-2\`, ...），为每册赋予清晰的 \`volumeTitle\`、独立 PDF 文件名 \`suggestedFileName\` 与角色 \`role\`（可选值：\`main_lecture\` / \`workbook\` / \`solutions_manual\` / \`chapter_volume\` / \`supplement_volume\`）。
- 若用户要求“答案和解析另外一份文件”，请将正文讲义/题本放入前序分册（其 \`includeAnswerKey\` 设为 \`false\`，避免剧透），并将全部例题/练习题的详尽解答与评分标准单独规划为独立的 \`solutions_manual\` 分册（优先调度 \`gemini-4-argon\` 执笔）！
- \`batches\` 中的每个模块必须通过 \`volumeId\` 和 \`volumeIndex\` 明确归属到对应的独立分册。`
    : `【文件输出组织规则】：
- 当前无需拆分为多份文件，请在 \`volumes\` 中仅规划 1 个主输出卷（\`vol-1\`），并将所有 \`batches\` 的 \`volumeId\` 设为 \`"vol-1"\`、\`volumeIndex\` 设为 \`1\`。但若你在审读用户指令时发现用户明确要求拆分为多份独立文件/独立答案册，也可在 \`volumes\` 中如实规划多个分册。`;

  const docTypeLabel =
    params.mode === 'workbook'
      ? '系统化分级学术练习题册（含基础巩固、综合进阶、压轴证明/建模题，以及完整分步解析与评分要点）'
      : '大学/研究生/竞赛级深度课程讲义（含彩色填色定义框、定理框与严密证明、Nano Banana 教学插图、典型例题演算框与易错警示框）';

  const pageOrientationPref: PageOrientationMode = currentJobSnapshot?.pageOrientation || 'auto';
  const resolvedOrientation = detectResolvedPageOrientation({
    explicitOrientation: pageOrientationPref,
    rawPrompt: params.rawUserPrompt,
    directivesTexts: liveDirectives.map((d) => d.text),
  });

  // Compact planning memory window (14,000 chars max instead of 140k!) keeps full heading/numbering/symbol ledgers
  // while cutting structured-JSON planning latency from 90s+ down to ~8–15s so planning NEVER stalls!
  const allOwnerJobs = currentJobSnapshot
    ? getAllHistoricalJobsForJobOwner(currentJobSnapshot)
    : [];
  const longContextMemoryBlock = currentJobSnapshot
    ? buildLongContextMemoryPrompt({
        currentJob: currentJobSnapshot,
        allUserJobs: allOwnerJobs,
        maxReferenceChars: 14_000,
      })
    : '';

  const orientationGuidance =
    resolvedOrientation === 'landscape'
      ? `\n7. 【横版 A4 宽屏演示 (PPT 级可读) 版式规则】：用户要求横版展示/演示版式（297×210mm）。请按高可读性的“宽屏教学幻灯片章节”节奏规划各模块的 \`sections\`，让每个二级标题对应一个主题鲜明、公式推导清晰、适合投影授课与平板横屏阅读的知识单元。`
      : '';

  const plannerInstruction = `你是基于 Gemini 4 Carbon 的学术出版总设计师与多模型协同调度主编，具备跨任务强历史记忆与百万级长上下文理解能力。
你的任务是：
1. 深度解析用户整合后的全部要求、抓取资料与历史长上下文，扩写为严谨的《扩展学术编纂规范》(expandedPrompt)，并在 \`orchestrationSummary\` 中简明阐述本次 Carbon 如何联合 Argon / Hydrogen / Nano Banana 等专精模型协同分工及控制单次输出甜点。
2. 100%继承关联前序文档的数学物理符号体系、术语约定与难度梯度。
3. 自动识别学科归属 (subjectCategory) 与课程编号 (courseCode)，生成专业总标题与文件名。
4. ${multiVolumeGuidance}
5. ${adaptiveRoundGuidance}
6. ${multiModelRoutingGuidance}${orientationGuidance}`;

  const userTaskText = `[目标文档形态]: ${docTypeLabel}
[页面版式]: ${resolvedOrientation === 'landscape' ? '横版宽屏演示 PDF (A4 Landscape 297×210mm · 适合课堂 PPT 投影与展示)' : '竖版标准学术 PDF (A4 Portrait 210×297mm)'}
[期望深度档位]: ${params.depth}（单次调用质量甜点目标：约 ${singleCallTargetWords.toLocaleString()} 字/模块 · 优先保证输出质量，最后自动无缝拼接）
[填色排版主题]: ${palette.label}（${palette.description}）
[Google Cloud 归档根目录]: ${params.customRootFolder || 'Carbon 学术归档'}
[自动整合后的全局需求规范 (v${consolidated.version})]:
${consolidated.synthesizedMasterBrief}

[用户原始输入全文]:
${params.rawUserPrompt.trim() || '请基于上传或链接抓取的参考文件/前序已完成文档，系统提炼并扩展生成完整文档。'}
${longContextMemoryBlock ? `\n${longContextMemoryBlock}\n` : ''}
请输出严格符合 JSON Schema 的扩展规划、多模型协同策略说明 (orchestrationSummary)、独立分册定义 (volumes) 与带专精模型指派的模块流 (batches)。`;

  const plannerModels = [CARBON_MODEL, 'gemini-4-argon', 'gemini-4-hydrogen'];
  const planSchema = {
    type: Type.OBJECT,
    properties: {
      documentTitle: { type: Type.STRING },
      subtitle: { type: Type.STRING },
      subjectCategory: { type: Type.STRING },
      courseCode: { type: Type.STRING },
      suggestedFileName: { type: Type.STRING },
      expandedPrompt: { type: Type.STRING },
      adaptiveStrategyNote: { type: Type.STRING },
      orchestrationSummary: { type: Type.STRING },
      pedagogicalGoals: { type: Type.ARRAY, items: { type: Type.STRING } },
      volumes: {
        type: Type.ARRAY,
        items: {
          type: Type.OBJECT,
          properties: {
            volumeId: { type: Type.STRING },
            volumeIndex: { type: Type.INTEGER },
            volumeTitle: { type: Type.STRING },
            subtitle: { type: Type.STRING },
            suggestedFileName: { type: Type.STRING },
            role: { type: Type.STRING },
            scopeSummary: { type: Type.STRING },
          },
          required: [
            'volumeId',
            'volumeIndex',
            'volumeTitle',
            'subtitle',
            'suggestedFileName',
            'role',
            'scopeSummary',
          ],
        },
      },
      batches: {
        type: Type.ARRAY,
        items: {
          type: Type.OBJECT,
          properties: {
            batchIndex: { type: Type.INTEGER },
            volumeId: { type: Type.STRING },
            volumeIndex: { type: Type.INTEGER },
            title: { type: Type.STRING },
            scopeSummary: { type: Type.STRING },
            sections: { type: Type.ARRAY, items: { type: Type.STRING } },
            estimatedPages: { type: Type.INTEGER },
            targetWords: { type: Type.INTEGER },
            includeAnswerKey: { type: Type.BOOLEAN },
            assignedModelId: { type: Type.STRING },
            specialistRole: { type: Type.STRING },
            dispatchReason: { type: Type.STRING },
            visualFigures: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                properties: {
                  figureId: { type: Type.STRING },
                  caption: { type: Type.STRING },
                  prompt: { type: Type.STRING },
                  aspectRatio: { type: Type.STRING },
                  assignedImageModelId: { type: Type.STRING },
                  placementSectionHint: { type: Type.STRING },
                },
                required: [
                  'figureId',
                  'caption',
                  'prompt',
                  'aspectRatio',
                  'assignedImageModelId',
                ],
              },
            },
          },
          required: [
            'batchIndex',
            'volumeId',
            'volumeIndex',
            'title',
            'scopeSummary',
            'sections',
            'estimatedPages',
            'targetWords',
            'includeAnswerKey',
            'assignedModelId',
            'dispatchReason',
          ],
        },
      },
    },
    required: [
      'documentTitle',
      'subtitle',
      'subjectCategory',
      'courseCode',
      'suggestedFileName',
      'expandedPrompt',
      'pedagogicalGoals',
      'volumes',
      'batches',
    ],
  };

  for (let attempt = 0; attempt < plannerModels.length; attempt++) {
    if (params.signal.aborted) throw new Error('ABORTED');
    const candidateModel = plannerModels[attempt];
    try {
      const planResult = await Promise.race([
        (async () => {
          const stream = await ai.models.generateContentStream({
            model: candidateModel,
            contents: { parts: [...attachmentParts, { text: userTaskText }] as never },
            config: {
              systemInstruction: plannerInstruction,
              thinkingConfig: {
                thinkingLevel: ThinkingLevel.MEDIUM,
              },
              responseMimeType: 'application/json',
              responseSchema: planSchema,
            },
          });

          let collected = '';
          let lastUsageChunk: GenerateContentResponse | null = null;
          let lastBeat = Date.now();
          for await (const rawChunk of stream) {
            if (params.signal.aborted) throw new Error('ABORTED');
            const chunk = rawChunk as GenerateContentResponse;
            if (chunk.usageMetadata) lastUsageChunk = chunk;
            if (chunk.text) {
              collected += chunk.text;
            }
            if (Date.now() - lastBeat > 4000) {
              lastBeat = Date.now();
              updateJobState(params.jobId, (prev) => prev, false);
            }
          }
          return { collected, lastUsageChunk };
        })(),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('PLANNING_TIMEOUT_75S')), 75_000)
        ),
      ]);

      if (planResult.lastUsageChunk) {
        addMeasuredUsageToJob(
          params.jobId,
          planResult.lastUsageChunk,
          candidateModel,
          '总纲规划与多模型协同路由调度'
        );
      }

      const rawText = (planResult.collected || '{}').trim();
      const jsonMatch = rawText.match(/\{[\s\S]*\}/);
      const parsed = JSON.parse(jsonMatch ? jsonMatch[0] : rawText) as Record<string, unknown>;

      return normalizeAdaptivePlanAndVolumes({
        rawParsed: parsed,
        mode: params.mode,
        depth: params.depth,
        customRootFolder: params.customRootFolder,
        rawUserPrompt: params.rawUserPrompt,
        multiVolumeDetection,
        colorTheme,
        autoGenerateFigures,
        pageOrientation: pageOrientationPref,
        directives: liveDirectives,
      });
    } catch (err) {
      if (params.signal.aborted || (err instanceof Error && err.message === 'ABORTED')) {
        throw new Error('ABORTED');
      }
      const info = formatGeminiError(err);
      if (!info.isTransient && String(err).includes('API_KEY_INVALID')) {
        throw err;
      }
      await new Promise((r) => setTimeout(r, 1200 * (attempt + 1)));
    }
  }

  // Ultimate Zero-Pause Guarantee: if all upstream JSON planning attempts timed out or truncated,
  // synthesize a deterministic multi-module / multi-volume plan immediately so execution proceeds seamlessly!
  const refJob = allOwnerJobs.find(
    (j) =>
      j.id === currentJobSnapshot?.parentJobId ||
      currentJobSnapshot?.sourceContextJobIds?.includes(j.id)
  );
  console.warn(
    `[Zero-Pause Planner Fallback] Using deterministic fallback plan for ${params.jobId} to prevent planning stall.`
  );
  return buildDeterministicFallbackPlan({
    mode: params.mode,
    depth: params.depth,
    customRootFolder: params.customRootFolder,
    rawUserPrompt: params.rawUserPrompt,
    consolidatedMasterBrief: consolidated.synthesizedMasterBrief,
    multiVolumeDetection,
    colorTheme,
    autoGenerateFigures,
    pageOrientation: pageOrientationPref,
    directives: liveDirectives,
    referenceJobTitle: refJob?.plan?.documentTitle,
  });
}

/**
 * Invokes Nano Banana (`gemini-nano-banana-2.1` / `gemini-3.1-flash-lite-image` / `gemini-3-pro-image`)
 * to generate publication-grade academic illustrations planned by Carbon for a module.
 * Strictly follows @google/genai image generation rules (NO responseMimeType / responseSchema,
 * iterates through candidate parts to locate inlineData). Non-fatal if an image call fails!
 */
async function generateModuleFiguresServer(params: {
  jobId: string;
  batchSpec: TaskBatchSpec;
  signal: AbortSignal;
}): Promise<GeneratedFigureAsset[]> {
  const specs = (params.batchSpec.visualFigures || []).slice(0, 2);
  if (specs.length === 0) return [];

  ensureStorageDirs();
  const ai = getGenAIClient();
  const jobMediaDir = path.join(MEDIA_CACHE_DIR, path.basename(params.jobId));
  fs.mkdirSync(jobMediaDir, { recursive: true });

  const generatedAssets: GeneratedFigureAsset[] = [];

  for (const spec of specs) {
    if (params.signal.aborted) throw new Error('ABORTED');

    const candidateModels =
      spec.assignedImageModelId === 'gemini-3.1-flash-lite-image'
        ? ['gemini-3.1-flash-lite-image', 'gemini-nano-banana-2.1']
        : [spec.assignedImageModelId, 'gemini-3.1-flash-lite-image'];

    for (const imgModel of candidateModels) {
      if (params.signal.aborted) throw new Error('ABORTED');
      try {
        const supportsExplicitSize =
          imgModel === 'gemini-nano-banana-2.1' || imgModel === 'gemini-3-pro-image';
        const imgResp = await ai.models.generateContent({
          model: imgModel,
          contents: {
            parts: [{ text: spec.prompt }],
          },
          config: {
            imageConfig: {
              aspectRatio: spec.aspectRatio || '16:9',
              ...(supportsExplicitSize ? { imageSize: '1K' } : {}),
            },
          },
        });

        let foundBase64 = '';
        let foundMime = 'image/png';
        for (const part of imgResp.candidates?.[0]?.content?.parts ?? []) {
          if (part.inlineData?.data) {
            foundBase64 = part.inlineData.data;
            foundMime = part.inlineData.mimeType || 'image/png';
            break;
          }
        }

        if (foundBase64) {
          const ext = foundMime.includes('jpeg') || foundMime.includes('jpg') ? 'jpg' : 'png';
          const safeFigId = spec.figureId.replace(/[^a-zA-Z0-9_-]/g, '-');
          const fileName = `${safeFigId}.${ext}`;
          const diskPath = path.join(jobMediaDir, fileName);
          fs.writeFileSync(diskPath, Buffer.from(foundBase64, 'base64'));

          addMeasuredUsageToJob(
            params.jobId,
            imgResp,
            imgModel,
            '学术原理与几何示意图绘制',
            1
          );

          generatedAssets.push({
            figureId: spec.figureId,
            batchIndex: params.batchSpec.batchIndex,
            volumeId: params.batchSpec.volumeId,
            caption: spec.caption,
            modelUsed: imgModel,
            aspectRatio: spec.aspectRatio,
            mimeType: foundMime,
            mediaUrl: `/api/jobs/${encodeURIComponent(params.jobId)}/media/${encodeURIComponent(fileName)}`,
            createdAt: new Date().toISOString(),
          });
          break;
        }
      } catch (imgErr) {
        if (params.signal.aborted) throw new Error('ABORTED');
        console.warn(
          `[Nano Banana] Model ${imgModel} warning for ${spec.figureId}, trying fallback if available:`,
          imgErr instanceof Error ? imgErr.message : String(imgErr)
        );
      }
    }
  }

  return generatedAssets;
}

/**
 * Streams a single quality-sized module or intra-module continuation pass on the server:
 * - Dispatches to Carbon's assigned specialist model (`Carbon` / `Argon` / `Hydrogen` / `Flash Lite`)
 *   with automatic fallback to `Carbon` on unexpected transient errors
 * - Formats semantic color-filled callout boxes (`:::definition`, `:::theorem`, `:::example`, `:::warning`, `:::summary`)
 * - Places `{{FIGURE:fig-id}}` anchors for Nano Banana illustrations
 * - Keeps per-call output at the quality sweet spot (~3,600–5,800 words) for zero mid-proof degradation
 */
async function executeBatchPassWithAutoRecovery(params: {
  jobId: string;
  batchIdx: number;
  mode: DocMode;
  depth: DepthPreset;
  plan: ExpandedPlan;
  batchSpec: ExpandedPlan['batches'][number];
  previousBatchesOutline: string;
  initialMarkdown: string;
  startAsContinuation: boolean;
  completedEarlierTexts: string[];
  signal: AbortSignal;
}): Promise<{
  rawPassOutput: string;
  mergedCleanText: string;
  finishReason: string;
  modelUsed: string;
}> {
  const ai = getGenAIClient();

  await ensureJobPromptLinksScanned(params.jobId);

  const liveJobRecord = jobsMap.get(params.jobId);
  const currentDirectives = liveJobRecord?.supplementalDirectives || [];

  if (liveJobRecord && currentDirectives.some((d) => d.status === 'queued')) {
    const freshConsolidated = consolidateRequirementsPure({
      rawUserPrompt: liveJobRecord.rawUserPrompt,
      directives: currentDirectives,
      scannedLinks: liveJobRecord.scannedLinks,
      volumeSplitMode: liveJobRecord.volumeSplitMode,
      previousVersion: liveJobRecord.consolidatedRequirements?.version || 0,
    });
    updateJobState(
      params.jobId,
      (prev) => ({
        ...prev,
        consolidatedRequirements: freshConsolidated,
        supplementalDirectives: (prev.supplementalDirectives || []).map((d) =>
          d.status === 'queued'
            ? { ...d, status: 'applied', appliedBatchIndex: params.batchSpec.batchIndex }
            : d
        ),
      }),
      true
    );
  }

  let baseMarkdown = params.initialMarkdown;
  let isCont = params.startAsContinuation && baseMarkdown.trim().length > 0;

  const allLoadedAttachments = loadJobAttachments(params.jobId);
  const attachmentsForPass = isCont
    ? allLoadedAttachments.filter((a) => Boolean(a.fileUri || a.serverFileId))
    : allLoadedAttachments;
  const attachmentParts = await buildAttachmentPartsAsync(attachmentsForPass);

  const refreshedJobRecord = jobsMap.get(params.jobId);
  const colorTheme: ColorPaletteTheme =
    refreshedJobRecord?.colorTheme || params.plan.colorTheme || 'academic_blue';
  const palette = resolveColorPaletteSpec(colorTheme);
  const currentVolume = params.plan.volumes?.find(
    (v) => v.volumeId === (params.batchSpec.volumeId || 'vol-1')
  );
  const hasSeparateSolutionsVol = Boolean(
    params.plan.volumes &&
      params.plan.volumes.length > 1 &&
      params.plan.volumes.some((v) => v.role === 'solutions_manual')
  );

  const hasFallbackUnscrapedWebUrl =
    !isCont &&
    attachmentParts.length === 0 &&
    (refreshedJobRecord?.scannedLinks || []).some(
      (l) => l.kind === 'web_page' && l.status !== 'ready'
    );

  const isSolutionsManualPass = currentVolume?.role === 'solutions_manual';
  const shouldWithholdSolutionsForSeparateVol =
    hasSeparateSolutionsVol && !isSolutionsManualPass && !params.batchSpec.includeAnswerKey;

  const plannedFigures =
    refreshedJobRecord?.autoGenerateFigures === false
      ? []
      : params.batchSpec.visualFigures || [];
  const figureAnchorInstructions =
    plannedFigures.length > 0
      ? `\n7. 【Nano Banana 学术配图锚点规范】：本模块已指派视觉模型绘制 ${plannedFigures.length} 幅插图，请在正文中对应知识点最契合的段落之间单独一行插入精确占位符（系统将自动嵌入高清配图）：\n${plannedFigures
          .map(
            (vf) =>
              `   - 单独一行输出 \`{{FIGURE:${vf.figureId}}}\`（对应图注：${vf.caption}）`
          )
          .join('\n')}`
      : '';

  const modeSpecificRules = isSolutionsManualPass
    ? `当前正在编纂【独立答案与详解专册 (${currentVolume?.volumeTitle})】：
- 本文件是与正文讲义/题本分离的独立答案解析 PDF！
- 必须严格逐题对应前序分册中的所有例题/训练题编号，使用 \`:::example 题 X.X 分步解析与采分标准\` 彩色框包裹关键采分总结，提供 100% 无跳步的完整推导、多解对比与易错点剖析，严禁出现“同理可得”、“计算略”！`
    : shouldWithholdSolutionsForSeparateVol
      ? `当前正在编纂【正文讲义/题本独立分册 (${currentVolume?.volumeTitle}) —— 答案解析将另附独立分册】：
- 用户要求将答案和详细解析单独成册输出！因此本分册专注于核心理论推导、彩色知识框、直观图解以及例题/训练题的**完整题干与清晰编号**（如 例 1.1、题 1.1），不要在本分册题干下方直接展开最终答案与题解！`
      : params.mode === 'workbook'
        ? `当前为【练习题册 PDF 模式】：
- 按梯度编排高质量题目（例如：**题 1.1 · 难度：进阶 · 考点：核心定理应用**）。
- 涵盖概念辨析题、计算推导题、综合应用/证明压轴题。
- 每道题均附上详尽分步解答与评分标准（可用 \`:::example 分步解析与评分标准\` 彩色填色框呈现核心推导与得分点），严禁出现“同理可得”、“证明略”！`
        : `当前为【出版级彩色课程讲义 PDF 模式（主题：${palette.label}）】：
- 遵循现代大学/竞赛全彩教材体例：背景动机 -> 彩色定义框 -> 彩色核心定理框与完整分步证明 -> 几何/物理直觉 -> 彩色典型例题演算框 -> 彩色易错警示框 -> 结构化总结表。
- 所有推导步骤、中间变换、边界条件必须 100% 详尽展开，严禁出现“显然”、“证明从略”！`;

  const isLandscapeDeck =
    detectResolvedPageOrientation({
      explicitOrientation: refreshedJobRecord?.pageOrientation,
      planOrientation: params.plan.pageOrientation,
      rawPrompt: refreshedJobRecord?.rawUserPrompt || '',
      directivesTexts: (refreshedJobRecord?.supplementalDirectives || []).map((d) => d.text),
    }) === 'landscape';

  const landscapeStyleClause = isLandscapeDeck
    ? '\n- 【横版宽屏演示 PPT 级可读性规范】：当前输出为横版 A4 (297×210mm) 演示讲义，请保持段落层次精炼醒目，善用彩色定义/定理/总结框、要点列表与结构化对比表，避免单段超长密排纯文字墙，确保投影授课与屏幕展示一目了然（同时数学推导步骤依然 100% 完整无跳步）！'
    : '';

  const assignedSpecialistId = params.batchSpec.assignedModelId || CARBON_MODEL;
  const specialistEntry = getToolModelEntry(assignedSpecialistId);

  const systemInstruction = `你是 Carbon 多模型协同出版工坊中的专精执笔引擎【${specialistEntry.displayName}】，当前承担职责：${
    params.batchSpec.dispatchReason || specialistEntry.bestForSummary
  }。
排版、填色知识框与质量规范：
1. 使用清晰的 Markdown 层级（# / ## / ###）与结构化表格（表头将自动按「${palette.label}」主题填色）。
2. 【出版级彩色填色排版规范】：对于核心定义、重要定理、典型例题演算、易错陷阱警示与章节方法总结，请主动使用以下独立闭合的语义填色框语法（开始行 \`:::类型 标题\`，结束行单独 \`:::\`，内部支持多段文字与 $$ 公式块）：
   - \`:::definition 定义 1.1：名称\` ... \`:::\`
   - \`:::theorem 定理 1.1：名称\` ... \`:::\`
   - \`:::example 例 1.1：典型算例\` ... \`:::\`
   - \`:::warning 易错辨析与边界条件\` ... \`:::\`
   - \`:::summary 核心方法速查\` ... \`:::\`
3. 所有数学公式必须使用标准 LaTeX 语法：行内公式 $...$，独立公式块独立成行 $$...$$（切勿将 \\texttt 嵌套在 \\textbf 内部，使用标准数学记号如 \\mathtt 或 \\mathbf）。
4. 严格保持跨模块、跨分册、跨历史关联任务的符号、章节号、定义/定理/例题/习题编号全局顺延一致，绝不重复前文已写内容！
5. 【质量优先 · 适度单次篇幅】：本模块聚焦把规划小节写精、写透、无跳步（理想篇幅约 ${params.batchSpec.targetWords.toLocaleString()} 字左右，不必盲目注水凑极限字数，确保每一行公式推导与排版质量达到出版水准）！不要输出任何寒暄语，直接从正文标题或续写断点处开始！
6. ${modeSpecificRules}${landscapeStyleClause}${figureAnchorInstructions}
8. 当本模块规划的所有小节 (${params.batchSpec.sections.join('、')}) 详尽撰写完毕、所有公式与 \`:::\` 填色框均完整闭合后，在全文最末尾单独一行输出标记：[[BATCH_COMPLETE]]。`;

  let lastErr: unknown;
  const fallbackCascadeModels = Array.from(
    new Set([assignedSpecialistId, CARBON_MODEL, 'gemini-4-argon', 'gemini-4-hydrogen'])
  );

  for (let recoveryAttempt = 0; recoveryAttempt <= 5; recoveryAttempt++) {
    if (params.signal.aborted) throw new Error('ABORTED');

    // Rotate across specialist & flagship models on retries so single-model congestion NEVER halts the pipeline!
    const activeModelId =
      recoveryAttempt === 0
        ? assignedSpecialistId
        : fallbackCascadeModels[recoveryAttempt % fallbackCascadeModels.length];
    const activeEntry = getToolModelEntry(activeModelId);
    const resolvedThinkingLevel =
      activeModelId === 'gemini-3.1-flash-lite'
        ? ThinkingLevel.LOW
        : recoveryAttempt >= 2 || activeModelId === 'gemini-4-hydrogen'
          ? ThinkingLevel.MEDIUM
          : params.depth === 'standard'
            ? ThinkingLevel.MEDIUM
            : ThinkingLevel.HIGH;

    let attemptRawChunk = '';
    let lastFlushTime = 0;
    let lastDiskPersistTime = Date.now();
    let latestChunkWithUsage: GenerateContentResponse | null = null;

    const latestJobSnap = jobsMap.get(params.jobId);
    const { consolidatedBriefBlock, memoryContextBlock } = latestJobSnap
      ? buildTokenEfficientExecutionContext({
          isContinuation: isCont,
          job: latestJobSnap,
          currentVolume,
          completedEarlierBatchTexts: params.completedEarlierTexts,
          allUserJobs: isCont ? [] : getAllHistoricalJobsForJobOwner(latestJobSnap),
        })
      : { consolidatedBriefBlock: '', memoryContextBlock: '' };

    const tailAnchor = baseMarkdown.slice(-480);
    const windowedCurrentBatchSoFar = isCont
      ? windowLongMarkdownContext(baseMarkdown, 16_000)
      : '';

    const taskPrompt = !isCont
      ? `[文档总标题]: ${params.plan.documentTitle} (${params.plan.courseCode})
[扩展编纂总纲]: ${params.plan.expandedPrompt}
${consolidatedBriefBlock}
[多模型模块化精编总览]: 当前执行第 ${params.batchSpec.batchIndex}/${params.plan.batches.length} 模块：《${params.batchSpec.title}》（执笔模型：${activeEntry.codeName}）
${params.previousBatchesOutline ? `[前序已完成模块结构提要（严禁重复，自然衔接后文）]:\n${params.previousBatchesOutline}\n` : ''}
${memoryContextBlock ? `${memoryContextBlock}\n\n` : ''}[本模块必须高质完整覆盖的小节清单]:
${params.batchSpec.sections.map((s, i) => `${i + 1}. ${s}`).join('\n')}
[本模块范围与质量甜点目标]: ${params.batchSpec.scopeSummary}（适度单次容量目标约 ${params.batchSpec.targetWords.toLocaleString()} 字，优先保证推导严谨度与彩色知识框排版质量，最后将自动与前后模块拼接）
请直接输出正式学术 Markdown 正文，全部完成后在末尾单独一行输出 [[BATCH_COMPLETE]]。`
      : `[高能效无缝断点续写指令]
你正在续写《${params.plan.documentTitle}》的第 ${params.batchSpec.batchIndex}/${params.plan.batches.length} 模块（${params.batchSpec.title}）。
本模块须完整覆盖的小节：${params.batchSpec.sections.join('、')}。
${consolidatedBriefBlock}
${memoryContextBlock ? `\n${memoryContextBlock}\n` : ''}
以下是本模块目前已生成内容的精简衔接窗口（总已写 ${baseMarkdown.length.toLocaleString()} 字符）：
--- 本模块已生成正文窗口开始 ---
${windowedCurrentBatchSoFar}
--- 本模块已生成正文窗口结束 ---

请严格紧接在以下末尾断点文字之后无缝继续撰写（严禁重复已输出的标题或句子，若上一句、公式或 \`:::\` 填色框未闭合请直接补全并继续完成本模块剩余小节）：
断点锚点：「${tailAnchor}」

当且仅当本模块剩余所有小节与整合要求全部撰写完毕后，在末尾单独一行输出 [[BATCH_COMPLETE]]。`;

    try {
      const stream = await ai.models.generateContentStream({
        model: activeModelId,
        contents: { parts: [...attachmentParts, { text: taskPrompt }] as never },
        config: {
          systemInstruction,
          thinkingConfig: {
            thinkingLevel: resolvedThinkingLevel,
          },
          ...(hasFallbackUnscrapedWebUrl ? { tools: [{ urlContext: {} }] } : {}),
        },
      });

      let finishReason = 'STOP';
      const iterator = stream[Symbol.asyncIterator]();
      let isFirstChunk = true;

      while (true) {
        const chunkTimeoutMs = isFirstChunk ? 85_000 : 45_000;
        const iterRes = await Promise.race([
          iterator.next(),
          new Promise<never>((_, reject) =>
            setTimeout(
              () => reject(new Error(`STREAM_CHUNK_INACTIVITY_TIMEOUT_${chunkTimeoutMs}MS`)),
              chunkTimeoutMs
            )
          ),
        ]);
        if (iterRes.done) break;
        isFirstChunk = false;
        const rawChunk = iterRes.value;
        if (params.signal.aborted) throw new Error('ABORTED');
        const chunk = rawChunk as GenerateContentResponse;
        if (chunk.usageMetadata) {
          latestChunkWithUsage = chunk;
        }
        const candidateReason = chunk.candidates?.[0]?.finishReason;
        if (candidateReason) {
          finishReason = String(candidateReason);
        }
        const piece = chunk.text;
        if (piece) {
          attemptRawChunk += piece;
          const now = Date.now();
          if (now - lastFlushTime > 380) {
            lastFlushTime = now;
            const shouldFlushDisk = now - lastDiskPersistTime > 2500;
            if (shouldFlushDisk) {
              lastDiskPersistTime = now;
            }
            const liveMerged = isCont
              ? mergeContinuationMarkdown(baseMarkdown, attemptRawChunk)
              : attemptRawChunk.replaceAll(BATCH_COMPLETE_MARKER, '');
            const fullMd = [...params.completedEarlierTexts, liveMerged]
              .filter(Boolean)
              .join('\n\n');
            const metrics = countAcademicMetrics(fullMd);

            updateJobState(
              params.jobId,
              (prev) => {
                const nextBatches = prev.batches.map((b, idx) =>
                  idx === params.batchIdx
                    ? { ...b, modelUsed: activeModelId, markdownContent: liveMerged }
                    : b
                );
                return {
                  ...prev,
                  updatedAt: new Date().toISOString(),
                  compiledMarkdown: fullMd,
                  charCount: metrics.charCount,
                  formulaCount: metrics.formulaCount,
                  estimatedPages: metrics.estimatedPages,
                  batches: nextBatches,
                  outputVolumes: computeVolumeArtifactsFromBatches({
                    plan: prev.plan,
                    batches: nextBatches,
                    existingVolumes: prev.outputVolumes,
                    defaultMode: prev.mode,
                    jobStage: prev.stage,
                  }),
                };
              },
              shouldFlushDisk
            );
          }
        }
      }

      if (latestChunkWithUsage) {
        addMeasuredUsageToJob(
          params.jobId,
          latestChunkWithUsage,
          activeModelId,
          activeEntry.workflowStages[0]
        );
      }

      const finalMerged = isCont
        ? mergeContinuationMarkdown(baseMarkdown, attemptRawChunk)
        : attemptRawChunk.replaceAll(BATCH_COMPLETE_MARKER, '').trimEnd();

      const hasSentinel = attemptRawChunk.includes(BATCH_COMPLETE_MARKER);
      return {
        rawPassOutput: hasSentinel ? `${finalMerged}\n${BATCH_COMPLETE_MARKER}` : finalMerged,
        mergedCleanText: finalMerged,
        finishReason,
        modelUsed: activeModelId,
      };
    } catch (err) {
      if (params.signal.aborted || (err instanceof Error && err.message === 'ABORTED')) {
        if (attemptRawChunk.trim()) {
          const savedCancel = isCont
            ? mergeContinuationMarkdown(baseMarkdown, attemptRawChunk)
            : attemptRawChunk.replaceAll(BATCH_COMPLETE_MARKER, '').trimEnd();
          const fullMd = [...params.completedEarlierTexts, savedCancel]
            .filter(Boolean)
            .join('\n\n');
          const metrics = countAcademicMetrics(fullMd);
          updateJobState(params.jobId, (prev) => {
            const nextBatches = prev.batches.map((b, idx) =>
              idx === params.batchIdx
                ? { ...b, modelUsed: activeModelId, markdownContent: savedCancel }
                : b
            );
            return {
              ...prev,
              compiledMarkdown: fullMd,
              charCount: metrics.charCount,
              formulaCount: metrics.formulaCount,
              estimatedPages: metrics.estimatedPages,
              batches: nextBatches,
              outputVolumes: computeVolumeArtifactsFromBatches({
                plan: prev.plan,
                batches: nextBatches,
                existingVolumes: prev.outputVolumes,
                defaultMode: prev.mode,
                jobStage: prev.stage,
              }),
            };
          });
        }
        throw new Error('ABORTED');
      }

      lastErr = err;
      if (attemptRawChunk.trim()) {
        baseMarkdown = isCont
          ? mergeContinuationMarkdown(baseMarkdown, attemptRawChunk)
          : attemptRawChunk.replaceAll(BATCH_COMPLETE_MARKER, '').trimEnd();
        isCont = baseMarkdown.trim().length > 0;

        const fullMd = [...params.completedEarlierTexts, baseMarkdown]
          .filter(Boolean)
          .join('\n\n');
        const metrics = countAcademicMetrics(fullMd);
        updateJobState(params.jobId, (prev) => {
          const nextBatches = prev.batches.map((b, idx) =>
            idx === params.batchIdx
              ? { ...b, modelUsed: activeModelId, markdownContent: baseMarkdown }
              : b
          );
          return {
            ...prev,
            compiledMarkdown: fullMd,
            charCount: metrics.charCount,
            formulaCount: metrics.formulaCount,
            estimatedPages: metrics.estimatedPages,
            batches: nextBatches,
            outputVolumes: computeVolumeArtifactsFromBatches({
              plan: prev.plan,
              batches: nextBatches,
              existingVolumes: prev.outputVolumes,
              defaultMode: prev.mode,
              jobStage: prev.stage,
            }),
          };
        });
      }

      const info = formatGeminiError(err);
      if (
        !info.isTransient &&
        String(err).includes('API_KEY_INVALID') &&
        attemptRawChunk.trim().length === 0
      ) {
        throw err;
      }
      if (recoveryAttempt === 5) {
        throw err;
      }

      updateJobState(params.jobId, (prev) => ({
        ...prev,
        autoRecoveryCount: (prev.autoRecoveryCount || 0) + 1,
        batches: prev.batches.map((b, idx) =>
          idx === params.batchIdx
            ? { ...b, autoRetryCount: (b.autoRetryCount || 0) + 1 }
            : b
        ),
      }));

      await new Promise((r) =>
        setTimeout(r, Math.min(8000, 1400 * Math.pow(1.7, recoveryAttempt)))
      );
    }
  }

  throw lastErr;
}

async function runDetachedPipelineWorker(params: {
  jobId: string;
  resumePhase: 'planning' | 'executing' | 'archiving';
  startBatchIdx: number;
  continuePartialBatch: boolean;
}): Promise<void> {
  const { jobId } = params;
  const existingCtrl = activeControllers.get(jobId);
  if (existingCtrl) {
    existingCtrl.abort();
  }
  const controller = new AbortController();
  activeControllers.set(jobId, controller);

  let currentStageForError: PipelineJob['stage'] = 'planning';

  try {
    let job = jobsMap.get(jobId);
    if (!job) return;

    await ensureJobPromptLinksScanned(jobId);
    job = jobsMap.get(jobId);
    if (!job) return;

    const initialAttachments = loadJobAttachments(jobId);
    let activePlan = job.plan;
    let startIdx = params.startBatchIdx;
    let usePartialFirstBatch = params.continuePartialBatch;

    // PHASE 1: Planning (Unbounded Adaptive Max-Single-Call Rounds + Multi-Volume Detection)
    if (params.resumePhase === 'planning' || !activePlan) {
      currentStageForError = 'planning';
      updateJobState(jobId, (prev) => ({
        ...prev,
        stage: 'planning',
        errorMessage: undefined,
        failedStage: undefined,
        updatedAt: new Date().toISOString(),
      }));

      activePlan = await generateExpandedPlanServer({
        jobId,
        mode: job.mode,
        depth: job.depth,
        rawUserPrompt: job.rawUserPrompt,
        customRootFolder: job.customRootFolder,
        attachments: initialAttachments,
        signal: controller.signal,
      });

      const resolvedFolder = buildDriveArchivePath({
        rootFolder: activePlan.archiveRootFolder || job.customRootFolder,
        subjectCategory: activePlan.subjectCategory,
        mode: job.mode,
      });

      const initialBatches: BatchExecutionState[] = activePlan.batches.map((b) => ({
        batchIndex: b.batchIndex,
        title: b.title,
        volumeId: b.volumeId,
        volumeIndex: b.volumeIndex,
        modelUsed: b.assignedModelId || CARBON_MODEL,
        status: 'pending',
        continuationCount: 0,
        autoRetryCount: 0,
        markdownContent: '',
      }));

      const initialVolumes = computeVolumeArtifactsFromBatches({
        plan: activePlan,
        batches: initialBatches,
        defaultMode: job.mode,
        jobStage: 'executing',
      });

      job = updateJobState(jobId, (prev) => ({
        ...prev,
        stage: 'executing',
        colorTheme: activePlan?.colorTheme || prev.colorTheme || 'academic_blue',
        isStitchedAndPolished: false,
        plan: activePlan,
        batches: initialBatches,
        outputVolumes: initialVolumes,
        supplementalDirectives: (prev.supplementalDirectives || []).map((d) => ({
          ...d,
          status: 'applied',
          appliedBatchIndex: 1,
        })),
        driveArchive: {
          ...prev.driveArchive,
          folderPath: resolvedFolder.fullPath,
        },
        updatedAt: new Date().toISOString(),
      }))!;

      startIdx = 0;
      usePartialFirstBatch = false;
      await syncLiveCheckpointToDrive(jobId);
    }

    // PHASE 2: Executing Multi-Model Modules + Nano Banana Figures + Seamless Final Stitching
    if (params.resumePhase !== 'archiving' && activePlan) {
      currentStageForError = 'executing';
      updateJobState(jobId, (prev) => ({
        ...prev,
        stage: 'executing',
        errorMessage: undefined,
        failedStage: undefined,
        outputVolumes: computeVolumeArtifactsFromBatches({
          plan: prev.plan,
          batches: prev.batches,
          existingVolumes: prev.outputVolumes,
          defaultMode: prev.mode,
          jobStage: 'executing',
        }),
        updatedAt: new Date().toISOString(),
      }));

      const latestJobBeforeExec = jobsMap.get(jobId)!;
      const batchOutputs = latestJobBeforeExec.batches.map((b) =>
        b.status === 'completed' ? b.markdownContent : ''
      );

      for (let i = startIdx; ; i++) {
        if (controller.signal.aborted) throw new Error('ABORTED');

        const checkQueuedBeforeRound = (jobsMap.get(jobId)?.supplementalDirectives || []).some(
          (d) => d.status === 'queued'
        );
        if (checkQueuedBeforeRound) {
          await reconcileQueuedSupplementsIntoWorkflowServer(jobId, i);
        }

        const liveJob = jobsMap.get(jobId);
        if (!liveJob || !liveJob.plan) break;
        activePlan = liveJob.plan;

        if (i >= activePlan.batches.length) {
          const stillQueued = (liveJob.supplementalDirectives || []).filter(
            (d) => d.status === 'queued'
          );
          if (stillQueued.length > 0) {
            await reconcileQueuedSupplementsIntoWorkflowServer(jobId, i);
            const postReconcilePlan = jobsMap.get(jobId)?.plan;
            if (postReconcilePlan && i < postReconcilePlan.batches.length) {
              activePlan = postReconcilePlan;
            } else {
              const nextIdx = activePlan.batches.length + 1;
              const singleCallWords = SINGLE_CALL_TARGET_WORDS_BY_DEPTH[liveJob.depth];
              const lastVol = activePlan.volumes?.[activePlan.volumes.length - 1];
              const suppSections = ['补充要求专项展开与严密推导', '增补资料解析与综合修正'];
              const routed = routeSpecialistModelForBatch({
                batchIndex: nextIdx,
                totalBatches: nextIdx,
                title: `动态整合补充模块（第 ${nextIdx} 模块）`,
                scopeSummary: stillQueued.map((u) => u.text).join('；'),
                sections: suppSections,
                mode: liveJob.mode,
                volumeRole: lastVol?.role,
              });
              const suppSpec: TaskBatchSpec = {
                batchIndex: nextIdx,
                title: `动态整合补充模块（第 ${nextIdx} 模块）`,
                scopeSummary:
                  stillQueued.map((u) => u.text).join('；') || '融合实时补充附件进行增补完善',
                sections: suppSections,
                estimatedPages: Math.max(4, Math.ceil(singleCallWords / 650)),
                targetWords: singleCallWords,
                includeAnswerKey: liveJob.mode === 'workbook',
                volumeId: lastVol?.volumeId || 'vol-1',
                volumeIndex: lastVol?.volumeIndex || 1,
                assignedModelId: routed.assignedModelId,
                specialistRole: routed.specialistRole,
                dispatchReason: routed.dispatchReason,
                isSupplementalBatch: true,
              };
              const nextPlan: ExpandedPlan = {
                ...activePlan,
                batches: [...activePlan.batches, suppSpec],
              };
              activePlan = nextPlan;
              updateJobState(jobId, (prev) => ({
                ...prev,
                plan: nextPlan,
                batches: [
                  ...prev.batches,
                  {
                    batchIndex: nextIdx,
                    title: suppSpec.title,
                    volumeId: suppSpec.volumeId,
                    volumeIndex: suppSpec.volumeIndex,
                    modelUsed: suppSpec.assignedModelId,
                    status: 'pending',
                    continuationCount: 0,
                    autoRetryCount: 0,
                    markdownContent: '',
                  },
                ],
              }));
            }
          } else {
            break;
          }
        }

        const currentBatchState = jobsMap.get(jobId)?.batches[i];
        if (
          i > startIdx &&
          currentBatchState?.status === 'completed' &&
          currentBatchState.markdownContent.trim().length > 0
        ) {
          batchOutputs[i] = currentBatchState.markdownContent;
          continue;
        }

        const batchSpec = activePlan.batches[i];
        let continuationCount =
          i === startIdx && usePartialFirstBatch
            ? currentBatchState?.continuationCount || 0
            : 0;
        let workingMarkdown =
          i === startIdx && usePartialFirstBatch
            ? currentBatchState?.markdownContent || ''
            : '';

        updateJobState(jobId, (prev) => {
          const nextBatches: BatchExecutionState[] = prev.batches.map((b, idx) =>
            idx === i
              ? {
                  ...b,
                  volumeId: b.volumeId || batchSpec.volumeId,
                  volumeIndex: b.volumeIndex || batchSpec.volumeIndex,
                  modelUsed: batchSpec.assignedModelId || b.modelUsed || CARBON_MODEL,
                  status: workingMarkdown ? 'continuing' : 'running',
                  startedAt: b.startedAt || new Date().toISOString(),
                  errorMessage: undefined,
                }
              : b
          );
          return {
            ...prev,
            batches: nextBatches,
            outputVolumes: computeVolumeArtifactsFromBatches({
              plan: prev.plan,
              batches: nextBatches,
              existingVolumes: prev.outputVolumes,
              defaultMode: prev.mode,
              jobStage: prev.stage,
            }),
          };
        });

        const previousOutline = activePlan.batches
          .slice(0, i)
          .map(
            (pb) =>
              `- 第 ${pb.batchIndex} 模块《${pb.title}》(${pb.volumeId || 'vol-1'})：已涵盖 ${pb.sections.join('、')}`
          )
          .join('\n');

        const completedEarlierTexts = batchOutputs.slice(0, i).filter(Boolean);

        const firstPass = await executeBatchPassWithAutoRecovery({
          jobId,
          batchIdx: i,
          mode: job.mode,
          depth: job.depth,
          plan: activePlan,
          batchSpec,
          previousBatchesOutline: previousOutline,
          initialMarkdown: workingMarkdown,
          startAsContinuation: Boolean(workingMarkdown.trim()),
          completedEarlierTexts,
          signal: controller.signal,
        });

        let activeBatchModelUsed = firstPass.modelUsed;
        let evalCont = evaluateBatchContinuation(
          firstPass.rawPassOutput,
          firstPass.finishReason,
          continuationCount
        );
        workingMarkdown = evalCont.cleanText;

        while (evalCont.shouldContinue) {
          if (controller.signal.aborted) throw new Error('ABORTED');
          continuationCount += 1;
          updateJobState(jobId, (prev) => ({
            ...prev,
            batches: prev.batches.map((b, idx) =>
              idx === i ? { ...b, status: 'continuing', continuationCount } : b
            ),
          }));

          const contPass = await executeBatchPassWithAutoRecovery({
            jobId,
            batchIdx: i,
            mode: job.mode,
            depth: job.depth,
            plan: activePlan,
            batchSpec,
            previousBatchesOutline: previousOutline,
            initialMarkdown: workingMarkdown,
            startAsContinuation: true,
            completedEarlierTexts,
            signal: controller.signal,
          });

          activeBatchModelUsed = contPass.modelUsed;
          evalCont = evaluateBatchContinuation(
            contPass.rawPassOutput,
            contPass.finishReason,
            continuationCount
          );
          workingMarkdown = evalCont.cleanText;
        }

        // Generate Nano Banana illustrations assigned to this module & inject seamlessly!
        let moduleGeneratedFigures: GeneratedFigureAsset[] =
          currentBatchState?.generatedFigures || [];
        const latestJobForImg = jobsMap.get(jobId);
        if (
          latestJobForImg?.autoGenerateFigures !== false &&
          (batchSpec.visualFigures?.length || 0) > 0 &&
          moduleGeneratedFigures.length === 0
        ) {
          moduleGeneratedFigures = await generateModuleFiguresServer({
            jobId,
            batchSpec,
            signal: controller.signal,
          });
        }

        workingMarkdown = injectGeneratedFiguresIntoModuleMarkdown(
          workingMarkdown,
          moduleGeneratedFigures
        );
        batchOutputs[i] = workingMarkdown;

        const afterRoundJob = updateJobState(jobId, (prev) => {
          const nextBatches: BatchExecutionState[] = prev.batches.map((b, idx) =>
            idx === i
              ? {
                  ...b,
                  volumeId: b.volumeId || batchSpec.volumeId,
                  volumeIndex: b.volumeIndex || batchSpec.volumeIndex,
                  modelUsed: activeBatchModelUsed,
                  generatedFigures: moduleGeneratedFigures,
                  status: 'completed',
                  continuationCount,
                  markdownContent: workingMarkdown,
                  completedAt: new Date().toISOString(),
                  errorMessage: undefined,
                }
              : b
          );

          const stitchedSoFar = stitchModularSectionsIntoDocument({
            modules: nextBatches
              .filter((b) => b.markdownContent.trim().length > 0)
              .map((b) => ({
                batchIndex: b.batchIndex,
                markdownContent: b.markdownContent,
                generatedFigures: b.generatedFigures,
              })),
          });
          const metrics = countAcademicMetrics(stitchedSoFar);

          const mergedJobFigsMap = new Map<string, GeneratedFigureAsset>();
          for (const f of prev.generatedFigures || []) mergedJobFigsMap.set(f.figureId, f);
          for (const f of moduleGeneratedFigures) mergedJobFigsMap.set(f.figureId, f);

          return {
            ...prev,
            updatedAt: new Date().toISOString(),
            compiledMarkdown: stitchedSoFar,
            charCount: metrics.charCount,
            formulaCount: metrics.formulaCount,
            estimatedPages: metrics.estimatedPages,
            generatedFigures: Array.from(mergedJobFigsMap.values()),
            batches: nextBatches,
            outputVolumes: computeVolumeArtifactsFromBatches({
              plan: prev.plan,
              batches: nextBatches,
              existingVolumes: prev.outputVolumes,
              defaultMode: prev.mode,
              jobStage: prev.stage,
            }),
          };
        });

        // Incremental Per-Volume PDF Pre-Compilation
        if (
          afterRoundJob &&
          afterRoundJob.outputVolumes &&
          afterRoundJob.outputVolumes.length > 1 &&
          batchSpec.volumeId
        ) {
          const justFinishedVol = afterRoundJob.outputVolumes.find(
            (v) =>
              v.volumeId === batchSpec.volumeId &&
              v.status === 'completed' &&
              !v.serverPdfReady &&
              v.compiledMarkdown.trim().length > 0
          );
          if (justFinishedVol) {
            try {
              const liveToken = resolveDriveToken(jobId, afterRoundJob.ownerEmail);
              const builtVolBuf = await compileServerPdfBuffer(
                afterRoundJob,
                liveToken,
                true,
                justFinishedVol
              );
              if (builtVolBuf) {
                updateJobState(jobId, (prev) => ({
                  ...prev,
                  outputVolumes: prev.outputVolumes?.map((v) =>
                    v.volumeId === justFinishedVol.volumeId ? { ...v, serverPdfReady: true } : v
                  ),
                }));
              }
            } catch (volPdfErr) {
              console.warn(
                `[Incremental Volume PDF] Deferred ${justFinishedVol.volumeId} to Phase 3:`,
                volPdfErr
              );
            }
          }
        }

        await syncLiveCheckpointToDrive(jobId);
      }
    }

    // PHASE 3: Final Master Modular Stitching + Server-Side PDF Compilation
    currentStageForError = 'compiling_pdf';
    const readyJob = updateJobState(jobId, (prev) => {
      const masterStitched = stitchModularSectionsIntoDocument({
        modules: prev.batches
          .filter((b) => b.markdownContent.trim().length > 0)
          .map((b) => ({
            batchIndex: b.batchIndex,
            markdownContent: b.markdownContent,
            generatedFigures: b.generatedFigures,
          })),
      });
      const finalMd = masterStitched || prev.compiledMarkdown;
      const finalMetrics = countAcademicMetrics(finalMd);
      return {
        ...prev,
        stage: 'compiling_pdf',
        isStitchedAndPolished: true,
        compiledMarkdown: finalMd,
        charCount: finalMetrics.charCount,
        formulaCount: finalMetrics.formulaCount,
        estimatedPages: finalMetrics.estimatedPages,
        outputVolumes: computeVolumeArtifactsFromBatches({
          plan: prev.plan,
          batches: prev.batches,
          existingVolumes: prev.outputVolumes,
          defaultMode: prev.mode,
          jobStage: 'compiling_pdf',
        }),
        updatedAt: new Date().toISOString(),
      };
    })!;

    const userCloudCfg = getUserCloudConfig(readyJob.ownerEmail);
    const driveToken = resolveDriveToken(jobId, readyJob.ownerEmail);
    const shouldCacheLocally = !(
      userCloudCfg.downloadOnDemandOnly &&
      driveToken &&
      readyJob.autoArchiveDrive
    );

    const isMultiVolOutput = Boolean(
      readyJob.outputVolumes && readyJob.outputVolumes.length > 1
    );

    let anyPdfCompiled = false;
    let pdfBuffer: Buffer | null = null;
    const compiledVolumeBuffers = new Map<string, Buffer>();

    if (isMultiVolOutput && readyJob.outputVolumes) {
      for (const vol of readyJob.outputVolumes) {
        if (!vol.compiledMarkdown.trim()) continue;
        try {
          const alreadyCached = getServerPdfPath(jobId, vol.volumeId);
          const volBuf = alreadyCached
            ? fs.readFileSync(alreadyCached)
            : await compileServerPdfBuffer(readyJob, driveToken, shouldCacheLocally, vol);
          if (volBuf) {
            anyPdfCompiled = true;
            compiledVolumeBuffers.set(vol.volumeId, volBuf);
            updateJobState(jobId, (prev) => ({
              ...prev,
              outputVolumes: prev.outputVolumes?.map((v) =>
                v.volumeId === vol.volumeId
                  ? { ...v, status: 'completed', serverPdfReady: true }
                  : v
              ),
            }));
          }
        } catch (volErr) {
          console.warn(
            `[Phase 3 Volume PDF] On-demand compilation will serve ${vol.volumeId}:`,
            volErr
          );
        }
      }
    }

    if (shouldCompileMergedFullPdfInWorker(readyJob.outputVolumes?.length || 0)) {
      try {
        pdfBuffer = await compileServerPdfBuffer(readyJob, driveToken, shouldCacheLocally);
        if (pdfBuffer) {
          anyPdfCompiled = true;
        }
      } catch (fullPdfErr) {
        console.warn('[Phase 3 Full PDF] On-demand compilation fallback:', fullPdfErr);
      }
    }

    const persistFallbackBuffersToLocalCache = () => {
      if (pdfBuffer && !getServerPdfPath(jobId)) {
        fs.writeFileSync(path.join(PDF_CACHE_DIR, `${jobId}.pdf`), pdfBuffer);
      }
      for (const [volId, vBuf] of compiledVolumeBuffers.entries()) {
        if (!getServerPdfPath(jobId, volId)) {
          const safeVolId = volId.replace(/[^a-zA-Z0-9_-]/g, '_');
          fs.writeFileSync(path.join(PDF_CACHE_DIR, `${jobId}__${safeVolId}.pdf`), vBuf);
        }
      }
    };

    // Reconcile actual measured token consumption into user's billing & 6h/weekly usage ledger
    if (readyJob.billing?.actualTotalTokens) {
      reconcileActualJobTokens({
        email: readyJob.ownerEmail,
        jobId,
        actualInputTokens: readyJob.billing.actualInputTokens || 0,
        actualOutputTokens: readyJob.billing.actualOutputTokens || 0,
        actualPages: readyJob.estimatedPages || 1,
      });
    }

    // PHASE 4: Priority Upload to User's Personal Google Cloud (Drive + optional GCS Bucket)
    const folderSpec = buildDriveArchivePath({
      rootFolder:
        readyJob.plan?.archiveRootFolder || readyJob.customRootFolder || userCloudCfg.driveRootFolder,
      subjectCategory: readyJob.plan?.subjectCategory,
      mode: readyJob.mode,
    });

    if (readyJob.autoArchiveDrive && driveToken && anyPdfCompiled) {
      currentStageForError = 'uploading_drive';
      updateJobState(jobId, (prev) => ({
        ...prev,
        stage: 'uploading_drive',
        serverPdfReady: true,
        driveArchive: {
          ...prev.driveArchive,
          status: 'uploading',
          folderPath: folderSpec.fullPath,
          error: undefined,
        },
      }));

      try {
        await archiveServerJobToDrive(jobId, driveToken);
        updateJobState(jobId, (prev) => ({
          ...prev,
          stage: 'completed',
          serverPdfReady: true,
          updatedAt: new Date().toISOString(),
          errorMessage: undefined,
          failedStage: undefined,
        }));
      } catch (driveErr) {
        persistFallbackBuffersToLocalCache();
        const dMsg = driveErr instanceof Error ? driveErr.message : String(driveErr);
        updateJobState(jobId, (prev) => ({
          ...prev,
          stage: 'completed',
          serverPdfReady: true,
          updatedAt: new Date().toISOString(),
          driveArchive: {
            ...prev.driveArchive,
            status: dMsg === 'DRIVE_AUTH_EXPIRED' ? 'pending_auth' : 'error',
            folderPath: folderSpec.fullPath,
            error:
              dMsg === 'DRIVE_AUTH_EXPIRED'
                ? '个人 Google Cloud 授权已过期，重新登录后点击一键归档即可直传专属云盘'
                : dMsg,
          },
        }));
      }
    } else {
      persistFallbackBuffersToLocalCache();
      updateJobState(jobId, (prev) => ({
        ...prev,
        stage: 'completed',
        serverPdfReady: anyPdfCompiled,
        outputVolumes: prev.outputVolumes?.map((v) =>
          v.compiledMarkdown.trim() ? { ...v, status: 'completed', serverPdfReady: true } : v
        ),
        updatedAt: new Date().toISOString(),
        errorMessage: undefined,
        failedStage: undefined,
        driveArchive: {
          ...prev.driveArchive,
          status: prev.autoArchiveDrive
            ? prev.driveArchive.status === 'archived'
              ? 'archived'
              : 'pending_auth'
            : 'idle',
          folderPath: folderSpec.fullPath,
        },
      }));
    }

    await syncLiveCheckpointToDrive(jobId);
  } catch (err) {
    // CRITICAL RACE GUARD: Only update stage if THIS worker controller is still the active controller for jobId!
    if (activeControllers.get(jobId) !== controller) {
      return;
    }

    if (controller.signal.aborted || (err instanceof Error && err.message === 'ABORTED')) {
      updateJobState(jobId, (prev) => ({
        ...prev,
        stage: 'cancelled',
        updatedAt: new Date().toISOString(),
      }));
    } else {
      const info = formatGeminiError(err);
      updateJobState(jobId, (prev) => ({
        ...prev,
        stage: 'error',
        failedStage: currentStageForError,
        errorMessage: info.message,
        updatedAt: new Date().toISOString(),
        batches: prev.batches.map((b) =>
          b.status === 'running' || b.status === 'continuing'
            ? { ...b, status: 'error', errorMessage: info.message }
            : b
        ),
      }));
    }
    await syncLiveCheckpointToDrive(jobId);
  } finally {
    if (activeControllers.get(jobId) === controller) {
      activeControllers.delete(jobId);
    }
  }
}

export function startNewDetachedJob(params: {
  jobId?: string;
  ownerEmail?: string | null;
  ownerUid?: string;
  clientDeviceId?: string;
  parentJobId?: string;
  sourceContextJobIds?: string[];
  enableHistoricalMemory?: boolean;
  scannedLinks?: ScannedLinkResult[];
  mode: DocMode;
  depth: DepthPreset;
  volumeSplitMode?: VolumeSplitMode;
  pageOrientation?: PageOrientationMode;
  colorTheme?: ColorPaletteTheme;
  autoGenerateFigures?: boolean;
  rawUserPrompt: string;
  customRootFolder: string;
  autoArchiveDrive: boolean;
  attachments: ServerAttachmentPayload[];
  driveToken?: string;
  billing?: JobBillingSnapshot;
}): PipelineJob {
  const jobId =
    params.jobId || `job-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const nowIso = new Date().toISOString();
  const ownerEmail = params.ownerEmail ? normalizeEmail(params.ownerEmail) : undefined;
  const userCloudCfg = getUserCloudConfig(ownerEmail);
  const rootFolder =
    params.customRootFolder.trim() || userCloudCfg.driveRootFolder || 'Carbon 学术归档';
  const volumeSplitMode: VolumeSplitMode = params.volumeSplitMode || 'auto';
  const pageOrientation: PageOrientationMode = params.pageOrientation || 'auto';
  const colorTheme: ColorPaletteTheme = params.colorTheme || 'academic_blue';
  const autoGenerateFigures = params.autoGenerateFigures ?? true;

  if (params.driveToken) {
    registerDriveToken(params.driveToken, jobId, ownerEmail);
  }
  saveJobAttachments(jobId, params.attachments);

  const folderPreview = buildDriveArchivePath({
    rootFolder,
    subjectCategory: '待识别学科',
    mode: params.mode,
  });

  const initialConsolidated = consolidateRequirementsPure({
    rawUserPrompt: params.rawUserPrompt.trim(),
    directives: [],
    scannedLinks: params.scannedLinks || [],
    volumeSplitMode,
    previousVersion: 0,
  });

  const newJob: PipelineJob = {
    id: jobId,
    createdAt: nowIso,
    updatedAt: nowIso,
    lastHeartbeatAt: nowIso,
    ownerEmail,
    ownerUid: params.ownerUid,
    clientDeviceId: params.clientDeviceId,
    parentJobId: params.parentJobId,
    sourceContextJobIds: params.sourceContextJobIds,
    enableHistoricalMemory: params.enableHistoricalMemory ?? true,
    expansionCount: 0,
    scannedLinks: params.scannedLinks || [],
    mode: params.mode,
    depth: params.depth,
    volumeSplitMode,
    pageOrientation,
    colorTheme,
    autoGenerateFigures,
    isStitchedAndPolished: false,
    generatedFigures: [],
    modelUsageBreakdown: [],
    multiModelTokenCostSavingsPct: 0,
    rawUserPrompt: params.rawUserPrompt.trim(),
    customRootFolder: rootFolder,
    autoArchiveDrive: params.autoArchiveDrive,
    attachmentsMeta: params.attachments.map((a, idx) => ({
      id: `att-${idx}-${Date.now()}`,
      name: a.name,
      mimeType: a.mimeType,
      size:
        a.size ||
        (a.base64Data
          ? Math.round((a.base64Data.length * 3) / 4)
          : (a.extractedText || '').length),
      kind: a.kind,
      serverFileId: a.serverFileId,
      fileUri: a.fileUri,
    })),
    supplementalDirectives: [],
    consolidatedRequirements: initialConsolidated,
    outputVolumes: [],
    stage: 'planning',
    executionHost: 'server_cloud',
    serverPdfReady: false,
    cloudOnlyHosted: userCloudCfg.downloadOnDemandOnly,
    autoRecoveryCount: 0,
    plan: null,
    batches: [],
    compiledMarkdown: '',
    charCount: 0,
    formulaCount: 0,
    estimatedPages: params.billing?.estimatedPages || 1,
    driveArchive: {
      status: 'idle',
      folderPath: folderPreview.fullPath,
    },
    billing: params.billing,
  };

  jobsMap.set(jobId, newJob);
  persistJobsToDisk();

  void runDetachedPipelineWorker({
    jobId,
    resumePhase: 'planning',
    startBatchIdx: 0,
    continuePartialBatch: false,
  });

  return newJob;
}

/**
 * Plans unbounded adaptive continuation/expansion modules at the end of an already COMPLETED document
 * using Gemini 4 Carbon with full long-context comprehension and specialist model routing.
 */
async function planInPlaceExpansionBatchesServer(params: {
  job: PipelineJob;
  expansionPrompt: string;
  depth: DepthPreset;
  attachments: ServerAttachmentPayload[];
}): Promise<{ newBatches: TaskBatchSpec[]; updatedSubtitle?: string; newVolumeSpec?: OutputVolumeSpec }> {
  const ai = getGenAIClient();
  const attachmentParts = await buildAttachmentPartsAsync(params.attachments);
  const ledger = extractAcademicHeadingAndSymbolLedger(params.job.compiledMarkdown);
  const windowedExisting = windowLongMarkdownContext(params.job.compiledMarkdown, 140_000);
  const startBatchNumber = (params.job.plan?.batches.length || params.job.batches.length) + 1;
  const singleCallWords = SINGLE_CALL_TARGET_WORDS_BY_DEPTH[params.depth];

  const splitIntent = detectMultiVolumeIntent({
    rawPrompt: params.expansionPrompt,
    explicitMode: 'auto',
  });

  const existingVols = params.job.plan?.volumes || [];
  const nextVolIdx = existingVols.length + 1;

  const systemInstruction = `你是《${
    params.job.plan?.documentTitle || '学术专著'
  }》的首席主编（Gemini 4 Carbon），正在基于已完成的全书正文进行【任务完成后无缝扩编续写】。
请严格阅读已完成正文的目录骨架、末尾定理/例题/习题编号与符号约定：
1. 控制每个新增模块的单次输出在质量甜点区间（每模块约 ${singleCallWords.toLocaleString()} 字），**不要固定模块轮次上限**，需要多少模块就拆分成多少模块，并为每个模块指派最适配专精模型（\`gemini-4-carbon\` / \`gemini-4-argon\` / \`gemini-4-hydrogen\` / \`gemini-3.1-flash-lite\`）！
2. 新模块的章节号、定理号、例题号或习题编号必须严格顺延已完成正文末尾编号（绝不重复已写内容）。
3. 若用户在本次扩展要求中明确提出输出新的独立文件/独立答案解析册（检测：${splitIntent.shouldSplitVolumes ? splitIntent.reasonSummary : '默认合编进现有主卷或最后分册'}），可在 \`createSeparateVolume = true\` 时定义一个新的独立分册。`;

  const promptText = `[已完成文档标题]: ${params.job.plan?.documentTitle || ''} (${
    params.job.plan?.courseCode || 'CARBON'
  })
[已完成总字数]: ${params.job.charCount.toLocaleString()} 字 · 已完成模块数: ${startBatchNumber - 1}
[已完成章节总览]: ${ledger.headings.join(' | ') || '见正文'}
[已完成末尾编号锚点]: ${ledger.lastNumberedAnchors.slice(-12).join(' ； ') || '顺延前文'}
[用户本次继续扩展任务要求]:
${params.expansionPrompt.trim() || '请在现有已完成内容基础上继续向后续核心章节、高阶专题与压轴综合应用深度扩展。'}

--- 已完成文档长上下文窗口开始 ---
${windowedExisting}
--- 已完成文档长上下文窗口结束 ---

请输出本次无缝扩编的新增模块规划 JSON。`;

  const response = await ai.models.generateContent({
    model: CARBON_MODEL,
    contents: { parts: [...attachmentParts, { text: promptText }] as never },
    config: {
      systemInstruction,
      thinkingConfig: { thinkingLevel: ThinkingLevel.HIGH },
      responseMimeType: 'application/json',
      responseSchema: {
        type: Type.OBJECT,
        properties: {
          updatedSubtitle: { type: Type.STRING },
          createSeparateVolume: { type: Type.BOOLEAN },
          newVolumeTitle: { type: Type.STRING },
          newVolumeFileName: { type: Type.STRING },
          newVolumeRole: { type: Type.STRING },
          batches: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                title: { type: Type.STRING },
                scopeSummary: { type: Type.STRING },
                sections: { type: Type.ARRAY, items: { type: Type.STRING } },
                estimatedPages: { type: Type.INTEGER },
                targetWords: { type: Type.INTEGER },
                includeAnswerKey: { type: Type.BOOLEAN },
                assignedModelId: { type: Type.STRING },
                dispatchReason: { type: Type.STRING },
              },
              required: [
                'title',
                'scopeSummary',
                'sections',
                'estimatedPages',
                'targetWords',
                'includeAnswerKey',
              ],
            },
          },
        },
        required: ['batches'],
      },
    },
  });

  addMeasuredUsageToJob(params.job.id, response, CARBON_MODEL, '长上下文扩编规划与模型路由');
  const raw = (response.text ?? '{}').trim();
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  const parsed = JSON.parse(jsonMatch ? jsonMatch[0] : raw) as Record<string, unknown>;

  let newVolumeSpec: OutputVolumeSpec | undefined;
  const shouldCreateNewVol = Boolean(parsed.createSeparateVolume) || splitIntent.shouldSplitVolumes;
  if (shouldCreateNewVol) {
    const rawRole = String(parsed.newVolumeRole || '');
    const role: VolumeRole =
      rawRole === 'solutions_manual' || splitIntent.hasSeparateSolutions
        ? 'solutions_manual'
        : 'supplement_volume';
    const vTitle = String(
      parsed.newVolumeTitle ||
        `${params.job.plan?.documentTitle || '扩展专著'} · 第 ${nextVolIdx} 分册`
    );
    newVolumeSpec = {
      volumeId: `vol-${nextVolIdx}`,
      volumeIndex: nextVolIdx,
      volumeTitle: vTitle,
      subtitle: '长上下文续编独立分册',
      suggestedFileName: normalizePdfFileName(
        String(parsed.newVolumeFileName || `${vTitle}.pdf`),
        role === 'solutions_manual' ? 'workbook' : params.job.mode
      ),
      role,
      scopeSummary: params.expansionPrompt,
    };
  }

  const targetVolId =
    newVolumeSpec?.volumeId ||
    existingVols[existingVols.length - 1]?.volumeId ||
    'vol-1';
  const targetVolIdx =
    newVolumeSpec?.volumeIndex ||
    existingVols[existingVols.length - 1]?.volumeIndex ||
    1;
  const targetVolRole =
    newVolumeSpec?.role || existingVols[existingVols.length - 1]?.role;

  const rawList = Array.isArray(parsed.batches) && parsed.batches.length > 0 ? parsed.batches : [];
  const newBatches: TaskBatchSpec[] =
    rawList.length > 0
      ? (rawList as Array<Record<string, unknown>>).map((b, idx) => {
          const bTitle = String(b.title || `后续扩展模块（第 ${startBatchNumber + idx} 模块）`);
          const bScope = String(b.scopeSummary || params.expansionPrompt);
          const bSections = Array.isArray(b.sections)
            ? b.sections.map(String)
            : ['后续深度扩展章节'];
          const routed = routeSpecialistModelForBatch({
            batchIndex: startBatchNumber + idx,
            totalBatches: startBatchNumber + rawList.length - 1,
            title: bTitle,
            scopeSummary: bScope,
            sections: bSections,
            mode: params.job.mode,
            volumeRole: targetVolRole,
            requestedModelId: b.assignedModelId ? String(b.assignedModelId) : undefined,
            requestedReason: b.dispatchReason ? String(b.dispatchReason) : undefined,
          });
          const clampedWords = clampModuleWordsToQualitySweetSpot(
            Number(b.targetWords) || singleCallWords,
            params.depth
          );
          return {
            batchIndex: startBatchNumber + idx,
            title: bTitle,
            scopeSummary: bScope,
            sections: bSections,
            estimatedPages: Math.max(4, Math.ceil(clampedWords / 650)),
            targetWords: clampedWords,
            includeAnswerKey: Boolean(
              b.includeAnswerKey ??
                (newVolumeSpec?.role === 'solutions_manual' || params.job.mode === 'workbook')
            ),
            volumeId: targetVolId,
            volumeIndex: targetVolIdx,
            assignedModelId: routed.assignedModelId,
            specialistRole: routed.specialistRole,
            dispatchReason: routed.dispatchReason,
            isExpansionBatch: true,
          };
        })
      : [
          (() => {
            const fallbackSections = ['后续进阶核心理论与证明', '综合拔高例题与拓展训练'];
            const routed = routeSpecialistModelForBatch({
              batchIndex: startBatchNumber,
              totalBatches: startBatchNumber,
              title: `后续深度扩展模块（第 ${startBatchNumber} 模块）`,
              scopeSummary: params.expansionPrompt,
              sections: fallbackSections,
              mode: params.job.mode,
              volumeRole: targetVolRole,
            });
            return {
              batchIndex: startBatchNumber,
              title: `后续深度扩展模块（第 ${startBatchNumber} 模块）`,
              scopeSummary: params.expansionPrompt || '基于已完成内容继续深度扩展新章节与高阶例题',
              sections: fallbackSections,
              estimatedPages: Math.max(4, Math.ceil(singleCallWords / 650)),
              targetWords: singleCallWords,
              includeAnswerKey:
                newVolumeSpec?.role === 'solutions_manual' || params.job.mode === 'workbook',
              volumeId: targetVolId,
              volumeIndex: targetVolIdx,
              assignedModelId: routed.assignedModelId,
              specialistRole: routed.specialistRole,
              dispatchReason: routed.dispatchReason,
              isExpansionBatch: true,
            };
          })(),
        ];

  return {
    newBatches,
    updatedSubtitle: parsed.updatedSubtitle ? String(parsed.updatedSubtitle) : undefined,
    newVolumeSpec,
  };
}

/**
 * Expands a COMPLETED job either:
 * - `append_in_place`: Seamlessly plans & appends new chapters/volumes onto the completed document.
 * - `derive_new_job`: Creates a new detached job bound to `jobId`'s full long-context memory.
 */
export async function expandCompletedServerJob(params: {
  sourceJobId: string;
  sourceJobSnapshot?: PipelineJob;
  expansionMode: PostCompletionExpansionMode;
  expansionPrompt: string;
  targetDocMode?: DocMode;
  depth?: DepthPreset;
  source?: 'text' | 'voice';
  attachments?: ServerAttachmentPayload[];
  scannedLinks?: ScannedLinkResult[];
  driveToken?: string;
  ownerEmail?: string | null;
  ownerUid?: string;
  clientDeviceId?: string;
  newJobId?: string;
  billing?: JobBillingSnapshot;
}): Promise<PipelineJob> {
  if (!jobsMap.has(params.sourceJobId) && params.sourceJobSnapshot?.id === params.sourceJobId) {
    jobsMap.set(params.sourceJobId, {
      ...params.sourceJobSnapshot,
      ownerEmail: normalizeEmail(params.ownerEmail) || params.sourceJobSnapshot.ownerEmail,
    });
    persistJobsToDisk();
  }

  const sourceJob = jobsMap.get(params.sourceJobId);
  if (!sourceJob) {
    throw new Error('未找到对应的已完成基准任务，无法执行后续扩展。');
  }

  const effectiveOwner = normalizeEmail(params.ownerEmail) || sourceJob.ownerEmail;
  if (params.driveToken) {
    registerDriveToken(params.driveToken, sourceJob.id, effectiveOwner);
  }

  const extraAttachments = [...(params.attachments || [])];
  const existingIds = new Set(
    extraAttachments.map((a) => a.serverFileId).filter((x): x is string => Boolean(x))
  );

  const { scannedLinks: newlyScannedLinks, ingestedAttachments } =
    await scanAndIngestLinksFromInput({
      rawText: params.expansionPrompt,
      driveToken: params.driveToken || resolveDriveToken(sourceJob.id, effectiveOwner),
      existingServerFileIds: existingIds,
    });

  const combinedAttachments = [...extraAttachments, ...ingestedAttachments];
  const mergedScannedLinks = [...(params.scannedLinks || []), ...newlyScannedLinks];

  if (params.expansionMode === 'derive_new_job') {
    const lineageIds = Array.from(
      new Set([sourceJob.id, ...(sourceJob.sourceContextJobIds || [])])
    );
    const targetMode = params.targetDocMode || sourceJob.mode;
    const defaultDerivedPrompt =
      targetMode === 'workbook' && sourceJob.mode === 'lecture_notes'
        ? `基于已完成讲义《${sourceJob.plan?.documentTitle || '前序讲义'}》的全部章节、定理与符号体系，深度编写完全配套的分级练习题册（含基础巩固、竞赛真题风格变式、综合压轴题及每道题的完整分步详解）。`
        : `基于已完成文档《${sourceJob.plan?.documentTitle || '前序文档'}》的长上下文记忆，继续编写进阶续篇/下册内容。`;

    return startNewDetachedJob({
      jobId: params.newJobId,
      ownerEmail: effectiveOwner,
      ownerUid: params.ownerUid || sourceJob.ownerUid,
      clientDeviceId: params.clientDeviceId || sourceJob.clientDeviceId,
      parentJobId: sourceJob.id,
      sourceContextJobIds: lineageIds,
      enableHistoricalMemory: true,
      scannedLinks: mergedScannedLinks,
      mode: targetMode,
      depth: params.depth || sourceJob.depth,
      volumeSplitMode: 'auto',
      colorTheme: sourceJob.colorTheme || sourceJob.plan?.colorTheme || 'academic_blue',
      autoGenerateFigures: sourceJob.autoGenerateFigures ?? true,
      rawUserPrompt: params.expansionPrompt.trim() || defaultDerivedPrompt,
      customRootFolder: sourceJob.customRootFolder,
      autoArchiveDrive: sourceJob.autoArchiveDrive,
      attachments: combinedAttachments,
      driveToken: params.driveToken || resolveDriveToken(sourceJob.id, effectiveOwner) || undefined,
      billing: params.billing,
    });
  }

  if (activeControllers.has(sourceJob.id)) {
    throw new Error('该任务当前正在后台运行中，请直接使用实时补充框注入要求。');
  }

  if (combinedAttachments.length > 0) {
    appendJobAttachments(sourceJob.id, combinedAttachments);
  }

  const newAttSummaries: AttachmentSummary[] = combinedAttachments.map((a, idx) => ({
    id: `exp-att-${Date.now()}-${idx}`,
    name: a.name,
    mimeType: a.mimeType,
    size: a.size || 0,
    kind: a.kind,
    serverFileId: a.serverFileId,
    fileUri: a.fileUri,
  }));

  updateJobState(sourceJob.id, (prev) => ({
    ...prev,
    stage: 'planning',
    serverPdfReady: false,
    isStitchedAndPolished: false,
    errorMessage: undefined,
    failedStage: undefined,
    updatedAt: new Date().toISOString(),
  }));

  const planned = await planInPlaceExpansionBatchesServer({
    job: sourceJob,
    expansionPrompt: params.expansionPrompt,
    depth: params.depth || sourceJob.depth,
    attachments: combinedAttachments,
  });

  const startBatchIdx = sourceJob.batches.length;
  const appendedBatchStates: BatchExecutionState[] = planned.newBatches.map((spec) => ({
    batchIndex: spec.batchIndex,
    title: spec.title,
    volumeId: spec.volumeId,
    volumeIndex: spec.volumeIndex,
    modelUsed: spec.assignedModelId,
    status: 'pending',
    continuationCount: 0,
    autoRetryCount: 0,
    markdownContent: '',
  }));

  const expansionDirective: SupplementalDirective = {
    id: `exp-dir-${Date.now()}`,
    createdAt: new Date().toISOString(),
    text: `[完成后无缝扩编] ${
      params.expansionPrompt.trim() || '基于已完成全文顺延扩编后续新章节与进阶题组'
    }`,
    source: params.source || 'text',
    attachmentsMeta: newAttSummaries,
    scannedLinks: mergedScannedLinks,
    status: 'applied',
    appliedBatchIndex: planned.newBatches[0]?.batchIndex || startBatchIdx + 1,
  };

  const expandedJob = updateJobState(sourceJob.id, (prev) => {
    const basePlan: ExpandedPlan = prev.plan || {
      documentTitle: '学术扩展专篇',
      subtitle: '长上下文连续扩编版',
      subjectCategory: '综合学术研究',
      courseCode: 'CARBON-101',
      archiveRootFolder: prev.customRootFolder || 'Carbon 学术归档',
      archiveSubjectFolder: '综合学术研究',
      suggestedFileName: 'Carbon_Expanded_Document.pdf',
      expandedPrompt: prev.rawUserPrompt,
      pedagogicalGoals: [],
      batches: [],
    };

    const baseVolumes: OutputVolumeSpec[] =
      basePlan.volumes && basePlan.volumes.length > 0
        ? [...basePlan.volumes]
        : [
            {
              volumeId: 'vol-1',
              volumeIndex: 1,
              volumeTitle: basePlan.documentTitle,
              subtitle: basePlan.subtitle,
              suggestedFileName: basePlan.suggestedFileName,
              role: prev.mode === 'workbook' ? 'workbook' : 'main_lecture',
              scopeSummary: basePlan.expandedPrompt,
            },
          ];

    if (planned.newVolumeSpec) {
      baseVolumes.push(planned.newVolumeSpec);
    }

    const existingLinksMap = new Map<string, ScannedLinkResult>();
    for (const l of prev.scannedLinks || []) existingLinksMap.set(l.url, l);
    for (const l of mergedScannedLinks) existingLinksMap.set(l.url, l);

    const nextDirectives = [...(prev.supplementalDirectives || []), expansionDirective];
    const nextPlan: ExpandedPlan = {
      ...basePlan,
      subtitle: planned.updatedSubtitle || basePlan.subtitle,
      isMultiVolume: baseVolumes.length > 1,
      volumes: baseVolumes,
      expandedPrompt: `${basePlan.expandedPrompt}\n\n[后续扩编要求 #${
        (prev.expansionCount || 0) + 1
      }]: ${params.expansionPrompt.trim()}`,
      batches: [...basePlan.batches, ...planned.newBatches],
    };
    const nextBatches = [...prev.batches, ...appendedBatchStates];

    return {
      ...prev,
      stage: 'executing',
      serverPdfReady: false,
      expansionCount: (prev.expansionCount || 0) + 1,
      depth: params.depth || prev.depth,
      scannedLinks: Array.from(existingLinksMap.values()),
      attachmentsMeta: [...prev.attachmentsMeta, ...newAttSummaries],
      supplementalDirectives: nextDirectives,
      consolidatedRequirements: consolidateRequirementsPure({
        rawUserPrompt: prev.rawUserPrompt,
        directives: nextDirectives,
        scannedLinks: Array.from(existingLinksMap.values()),
        volumeSplitMode: prev.volumeSplitMode,
        previousVersion: prev.consolidatedRequirements?.version || 0,
      }),
      plan: nextPlan,
      batches: nextBatches,
      outputVolumes: computeVolumeArtifactsFromBatches({
        plan: nextPlan,
        batches: nextBatches,
        existingVolumes: prev.outputVolumes,
        defaultMode: prev.mode,
        jobStage: 'executing',
      }),
      updatedAt: new Date().toISOString(),
    };
  })!;

  void runDetachedPipelineWorker({
    jobId: expandedJob.id,
    resumePhase: 'executing',
    startBatchIdx,
    continuePartialBatch: false,
  });

  return expandedJob;
}

export function resumeDetachedJob(params: {
  incomingJob: PipelineJob;
  strategy: ResumeStrategy;
  targetBatchIndex?: number;
  attachments?: ServerAttachmentPayload[];
  driveToken?: string;
  ownerEmail?: string | null;
}): PipelineJob {
  const existing = jobsMap.get(params.incomingJob.id);
  const resolvedOwner =
    normalizeEmail(params.ownerEmail) ||
    existing?.ownerEmail ||
    params.incomingJob.ownerEmail;

  const baseJob: PipelineJob = existing
    ? {
        ...existing,
        ownerEmail: resolvedOwner || existing.ownerEmail,
        plan: existing.plan || params.incomingJob.plan,
        batches:
          existing.batches.length >= params.incomingJob.batches.length
            ? existing.batches
            : params.incomingJob.batches,
        compiledMarkdown:
          existing.compiledMarkdown.length >= params.incomingJob.compiledMarkdown.length
            ? existing.compiledMarkdown
            : params.incomingJob.compiledMarkdown,
      }
    : {
        ...params.incomingJob,
        ownerEmail: resolvedOwner,
      };

  const jobId = baseJob.id;
  if (params.driveToken) {
    registerDriveToken(params.driveToken, jobId, resolvedOwner);
  }
  if (params.attachments && params.attachments.length > 0) {
    saveJobAttachments(jobId, params.attachments);
  }

  // Hydrate multi-volume specs onto legacy pre-upgrade jobs if their prompt explicitly requested multi-volume split!
  let hydratedPlan = baseJob.plan;
  if (hydratedPlan && (!hydratedPlan.volumes || hydratedPlan.volumes.length === 0)) {
    const splitDet = detectMultiVolumeIntent({
      rawPrompt: baseJob.rawUserPrompt,
      directives: baseJob.supplementalDirectives,
      explicitMode: baseJob.volumeSplitMode,
    });
    hydratedPlan = normalizeAdaptivePlanAndVolumes({
      rawParsed: hydratedPlan as unknown as Record<string, unknown>,
      mode: baseJob.mode,
      depth: baseJob.depth,
      customRootFolder: baseJob.customRootFolder,
      rawUserPrompt: baseJob.rawUserPrompt,
      multiVolumeDetection: splitDet,
      pageOrientation: baseJob.pageOrientation,
      directives: baseJob.supplementalDirectives,
    });
  }

  const jobWithHydratedPlan: PipelineJob = {
    ...baseJob,
    plan: hydratedPlan,
  };

  const descriptor = computeResumeDescriptor(
    jobWithHydratedPlan,
    params.strategy,
    params.targetBatchIndex
  );

  const metrics = countAcademicMetrics(descriptor.combinedMarkdownBeforeResume);
  const nextStage: PipelineJob['stage'] =
    descriptor.resumePhase === 'planning'
      ? 'planning'
      : descriptor.resumePhase === 'archiving'
        ? 'compiling_pdf'
        : 'executing';

  const nowBeat = new Date().toISOString();
  const preparedJob: PipelineJob = {
    ...jobWithHydratedPlan,
    executionHost: 'server_cloud',
    stage: nextStage,
    failedStage: undefined,
    errorMessage: undefined,
    updatedAt: nowBeat,
    lastHeartbeatAt: nowBeat,
    batches: descriptor.updatedBatches,
    consolidatedRequirements:
      baseJob.consolidatedRequirements ||
      consolidateRequirementsPure({
        rawUserPrompt: baseJob.rawUserPrompt,
        directives: baseJob.supplementalDirectives,
        scannedLinks: baseJob.scannedLinks,
        volumeSplitMode: baseJob.volumeSplitMode,
      }),
    outputVolumes: computeVolumeArtifactsFromBatches({
      plan: hydratedPlan,
      batches: descriptor.updatedBatches,
      existingVolumes: baseJob.outputVolumes,
      defaultMode: baseJob.mode,
      jobStage: nextStage,
    }),
    compiledMarkdown: descriptor.combinedMarkdownBeforeResume,
    charCount: metrics.charCount,
    formulaCount: metrics.formulaCount,
    estimatedPages: metrics.estimatedPages,
  };

  jobsMap.set(jobId, preparedJob);
  persistJobsToDisk();

  void runDetachedPipelineWorker({
    jobId,
    resumePhase: descriptor.resumePhase,
    startBatchIdx: descriptor.startBatchIdx,
    continuePartialBatch: descriptor.continuePartialBatch,
  });

  return preparedJob;
}
