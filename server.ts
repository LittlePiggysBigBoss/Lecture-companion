import 'dotenv/config';
import express from 'express';
import type { Request, Response } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import mammoth from 'mammoth';
import type {
  AttachmentSummary,
  DepthPreset,
  DocMode,
  PipelineJob,
  PostCompletionExpansionMode,
  PricingConfig,
  ResumeStrategy,
  ScannedLinkResult,
  UserCloudConfig,
  VolumeSplitMode,
} from './src/types.ts';
import {
  appendSupplementalDirectiveToJob,
  archiveServerJobToDrive,
  cancelServerJob,
  CARBON_MODEL,
  deleteServerJob,
  expandCompletedServerJob,
  getCachedDriveTokenForUser,
  getServerJob,
  listServerJobs,
  listServerJobsForUser,
  loadJobsFromDisk,
  registerDriveToken,
  resumeDetachedJob,
  startNewDetachedJob,
  streamOrCompileJobPdfOnDemand,
  syncJobsFromGoogleDrive,
} from './src/server/cloudJobRunner.ts';
import type { ServerAttachmentPayload } from './src/server/cloudJobRunner.ts';
import { scanAndIngestLinksFromInput } from './src/server/linkScannerService.ts';
import {
  activateMonthlySubscription,
  adminGrantUserPrivilege,
  authorizeAndSettleJobLaunch,
  buildAdminOverview,
  getPricingConfig,
  loadAccountStoreFromDisk,
  topUpUserWallet,
  updatePricingConfigByAdmin,
  updateUserCloudConfig,
  verifyRequestGoogleUser,
} from './src/server/accountAndBillingStore.ts';
import {
  appendUploadChunk,
  finalizeChunkedUpload,
  initChunkedUpload,
  loadUploadRegistryFromDisk,
  TRANSCRIBE_MODEL,
  transcribeVoiceDictationServer,
} from './src/server/unlimitedFileStore.ts';
import {
  computeMonthlyPlanEconomics,
  estimateTaskTokenAndPrice,
} from './src/utils/billingAndQuota.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function extractBearerToken(req: Request): string | undefined {
  const header = req.headers.authorization;
  if (!header) return undefined;
  return header.replace(/^Bearer\s+/i, '').trim() || undefined;
}

function extractClientDeviceId(req: Request): string | undefined {
  const raw = String(req.headers['x-client-device-id'] || '').trim();
  return raw || undefined;
}

async function startServer() {
  loadAccountStoreFromDisk();
  loadUploadRegistryFromDisk();
  loadJobsFromDisk();

  const app = express();

  // Binary chunked upload route (bypasses JSON base64 overhead & supports unlimited file size!)
  app.post(
    '/api/files/upload-chunk',
    express.raw({ type: 'application/octet-stream', limit: '25mb' }),
    (req: Request, res: Response) => {
      try {
        const serverFileId = String(req.query.serverFileId || req.headers['x-upload-file-id'] || '').trim();
        if (!serverFileId) {
          res.status(400).json({ error: '缺少上传会话 ID (serverFileId)' });
          return;
        }
        const buf = Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body || '');
        const result = appendUploadChunk(serverFileId, buf);
        res.json({ ok: true, ...result });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        res.status(500).json({ error: msg });
      }
    }
  );

  app.use(express.json({ limit: '50mb' }));

  app.get('/api/health', (_req: Request, res: Response) => {
    res.json({
      ok: true,
      model: CARBON_MODEL,
      transcribeModel: TRANSCRIBE_MODEL,
      hasApiKey: Boolean(process.env.GEMINI_API_KEY),
    });
  });

  // ============================================================================
  // Unlimited-Size Chunked File Upload & Voice Dictation Endpoints
  // ============================================================================

  app.post('/api/files/upload-init', (req: Request, res: Response) => {
    try {
      const { fileName = 'attachment.bin', mimeType = 'application/octet-stream', totalSize = 0 } =
        req.body as {
          fileName?: string;
          mimeType?: string;
          totalSize?: number;
        };
      const session = initChunkedUpload({ fileName, mimeType, totalSize });
      res.json(session);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
  });

  app.post('/api/files/upload-complete', async (req: Request, res: Response) => {
    try {
      const { serverFileId } = req.body as { serverFileId?: string };
      if (!serverFileId) {
        res.status(400).json({ error: '缺少 serverFileId' });
        return;
      }
      const completed = await finalizeChunkedUpload(serverFileId);
      res.json(completed);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
  });

  app.post('/api/files/parse-docx', async (req: Request, res: Response) => {
    try {
      const { base64Data, name } = req.body as { base64Data?: string; name?: string };
      if (!base64Data) {
        res.status(400).json({ error: '缺少 DOCX 文件数据' });
        return;
      }
      const buffer = Buffer.from(base64Data, 'base64');
      const result = await mammoth.extractRawText({ buffer });
      res.json({
        name: name || 'document.docx',
        extractedText: (result.value || '').trim(),
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: `解析 Word 文档失败: ${msg}` });
    }
  });

  app.post('/api/audio/transcribe', async (req: Request, res: Response) => {
    try {
      const { base64Audio, mimeType = 'audio/webm' } = req.body as {
        base64Audio?: string;
        mimeType?: string;
      };
      if (!base64Audio) {
        res.status(400).json({ error: '未检测到录音音频数据' });
        return;
      }
      const transcript = await transcribeVoiceDictationServer({ base64Audio, mimeType });
      res.json({ text: transcript });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: `语音识别转写失败: ${msg}` });
    }
  });

  // Automatic File / Google Drive / Docs / arXiv / Web URL Recognition & Multimodal Scraping
  app.post('/api/links/scan', async (req: Request, res: Response) => {
    try {
      const { rawText = '', urls = [], forceRefresh = false } = req.body as {
        rawText?: string;
        urls?: string[];
        forceRefresh?: boolean;
      };
      const verified = await verifyRequestGoogleUser(req);
      const driveToken =
        extractBearerToken(req) || getCachedDriveTokenForUser(verified?.email);
      const scanned = await scanAndIngestLinksFromInput({
        rawText,
        urls,
        driveToken,
        forceRefresh,
      });
      res.json(scanned);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: `链接识别抓取异常: ${msg}` });
    }
  });

  // ============================================================================
  // Account, Per-User Personal Cloud Config, Billing & Super Admin Console
  // ============================================================================

  app.get('/api/account/me', async (req: Request, res: Response) => {
    try {
      const pricing = getPricingConfig();
      const monthlyEconomics = computeMonthlyPlanEconomics(pricing);
      const verified = await verifyRequestGoogleUser(req);
      if (verified?.driveAccessToken) {
        registerDriveToken(verified.driveAccessToken, undefined, verified.email);
      }
      res.json({
        authenticated: Boolean(verified),
        profile: verified?.profile || null,
        pricing,
        monthlyEconomics,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
  });

  app.post('/api/account/cloud-config', async (req: Request, res: Response) => {
    try {
      const verified = await verifyRequestGoogleUser(req);
      if (!verified) {
        res.status(401).json({ error: '请先登录您的 Google 账号后再保存专属云端托管配置。' });
        return;
      }
      const patch = req.body as Partial<UserCloudConfig>;
      const profile = updateUserCloudConfig(verified.email, patch);
      res.json({ profile });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
  });

  app.post('/api/billing/estimate', (req: Request, res: Response) => {
    const {
      mode = 'lecture_notes',
      depth = 'comprehensive',
      promptLength = 200,
      attachments = [],
      customPageCount,
    } = req.body as {
      mode?: DocMode;
      depth?: DepthPreset;
      promptLength?: number;
      attachments?: Pick<AttachmentSummary, 'kind' | 'size'>[];
      customPageCount?: number;
    };
    const pricing = getPricingConfig();
    const estimate = estimateTaskTokenAndPrice({
      mode,
      depth,
      promptLength,
      attachments,
      customPageCount,
      pricing,
    });
    res.json({ estimate, pricing });
  });

  app.post('/api/billing/topup', async (req: Request, res: Response) => {
    try {
      const verified = await verifyRequestGoogleUser(req);
      if (!verified) {
        res.status(401).json({ error: '请先登录 Google 账号后再进行按次生成钱包充值。' });
        return;
      }
      const { amountCny = 20 } = req.body as { amountCny?: number };
      const profile = topUpUserWallet(
        verified.email,
        Number(amountCny) || 20,
        `按页生成 PDF 钱包充值 +¥${(Number(amountCny) || 20).toFixed(2)}`
      );
      res.json({ profile });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
  });

  app.post('/api/billing/subscribe-monthly', async (req: Request, res: Response) => {
    try {
      const verified = await verifyRequestGoogleUser(req);
      if (!verified) {
        res.status(401).json({ error: '请先登录 Google 账号后再开通 ¥300/月 包月会员。' });
        return;
      }
      const { useWalletIfEnough = false } = req.body as { useWalletIfEnough?: boolean };
      const profile = activateMonthlySubscription(verified.email, useWalletIfEnough);
      res.json({ profile });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
  });

  app.get('/api/admin/overview', async (req: Request, res: Response) => {
    try {
      const verified = await verifyRequestGoogleUser(req);
      if (!verified || !verified.profile.isSuperAdmin) {
        res.status(403).json({ error: '仅超级管理员可访问全局计费与配额管理面板。' });
        return;
      }
      const globalJobs = listServerJobs();
      const overview = buildAdminOverview({
        activeRunningJobsCount: globalJobs.activeJobIds.length,
        totalJobsCount: globalJobs.jobs.length,
      });
      res.json({ overview });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
  });

  app.post('/api/admin/pricing', async (req: Request, res: Response) => {
    try {
      const verified = await verifyRequestGoogleUser(req);
      if (!verified || !verified.profile.isSuperAdmin) {
        res.status(403).json({ error: '仅超级管理员可修改全局收费与毛利率标准。' });
        return;
      }
      const patch = req.body as Partial<PricingConfig>;
      const pricing = updatePricingConfigByAdmin(patch);
      const monthlyEconomics = computeMonthlyPlanEconomics(pricing);
      res.json({ pricing, monthlyEconomics });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
  });

  app.post('/api/admin/grant', async (req: Request, res: Response) => {
    try {
      const verified = await verifyRequestGoogleUser(req);
      if (!verified || !verified.profile.isSuperAdmin) {
        res.status(403).json({ error: '仅超级管理员可授予用户额度或包月权限。' });
        return;
      }
      const { targetEmail, addBalanceCny, grantMonthlyDays } = req.body as {
        targetEmail?: string;
        addBalanceCny?: number;
        grantMonthlyDays?: number;
      };
      if (!targetEmail || !targetEmail.trim()) {
        res.status(400).json({ error: '请输入目标用户的 Google 邮箱地址' });
        return;
      }
      const updatedUser = adminGrantUserPrivilege({
        targetEmail: targetEmail.trim(),
        addBalanceCny: Number(addBalanceCny) || 0,
        grantMonthlyDays: Number(grantMonthlyDays) || 0,
      });
      const globalJobs = listServerJobs();
      const overview = buildAdminOverview({
        activeRunningJobsCount: globalJobs.activeJobIds.length,
        totalJobsCount: globalJobs.jobs.length,
      });
      res.json({ updatedUser, overview });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
  });

  // ============================================================================
  // Multi-Device Synced Cloud Jobs + Live Supplement + On-Demand PDF Download
  // ============================================================================

  app.get('/api/jobs', async (req: Request, res: Response) => {
    const token = extractBearerToken(req);
    const clientDeviceId = extractClientDeviceId(req);
    const verified = await verifyRequestGoogleUser(req);
    if (token && verified?.email) {
      registerDriveToken(token, undefined, verified.email);
    }
    res.json(
      listServerJobsForUser({
        ownerEmail: verified?.email,
        clientDeviceId,
      })
    );
  });

  app.post('/api/jobs/start', async (req: Request, res: Response) => {
    try {
      const {
        mode = 'lecture_notes',
        depth = 'comprehensive',
        volumeSplitMode = 'auto',
        rawUserPrompt = '',
        customRootFolder = 'Carbon 学术归档',
        autoArchiveDrive = true,
        attachments = [],
        parentJobId,
        sourceContextJobIds = [],
        enableHistoricalMemory = true,
        scannedLinks = [],
        preferredBillingMethod = 'auto',
      } = req.body as {
        mode?: DocMode;
        depth?: DepthPreset;
        volumeSplitMode?: VolumeSplitMode;
        rawUserPrompt?: string;
        customRootFolder?: string;
        autoArchiveDrive?: boolean;
        attachments?: ServerAttachmentPayload[];
        parentJobId?: string;
        sourceContextJobIds?: string[];
        enableHistoricalMemory?: boolean;
        scannedLinks?: ScannedLinkResult[];
        preferredBillingMethod?: 'auto' | 'monthly_quota' | 'pay_per_pdf';
      };

      if (
        !rawUserPrompt.trim() &&
        attachments.length === 0 &&
        sourceContextJobIds.length === 0
      ) {
        res.status(400).json({ error: '请输入主题要求、粘贴云盘/网页链接，或上传至少一份参考文档。' });
        return;
      }

      const verified = await verifyRequestGoogleUser(req);
      if (!verified) {
        res.status(401).json({
          error:
            '请先点击右上角登录您的 Google 账号：用于绑定多终端实时同步、挂载您个人的 Google Cloud 存储，并核算按页生成或包月会员额度。',
          code: 'AUTH_REQUIRED',
        });
        return;
      }

      const pricing = getPricingConfig();
      const estimate = estimateTaskTokenAndPrice({
        mode,
        depth,
        promptLength: rawUserPrompt.length,
        attachments: attachments.map((a) => ({
          kind: a.kind,
          size:
            a.size ||
            (a.base64Data
              ? Math.round((a.base64Data.length * 3) / 4)
              : (a.extractedText || '').length),
        })),
        pricing,
      });

      const jobId = `job-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      const settlement = authorizeAndSettleJobLaunch({
        email: verified.email,
        jobId,
        jobTitleHint: rawUserPrompt.trim() || attachments[0]?.name || '长上下文学术生成任务',
        estimate,
        preferredMethod: preferredBillingMethod,
      });

      if (!settlement.allowed) {
        res.status(402).json({
          error: settlement.reason || '当前账户余额或周期额度不足',
          code: 'BILLING_REQUIRED',
          estimate,
          profile: settlement.profile,
        });
        return;
      }

      const driveToken = extractBearerToken(req);
      const job = startNewDetachedJob({
        jobId,
        ownerEmail: verified.email,
        ownerUid: verified.uid,
        clientDeviceId: extractClientDeviceId(req),
        parentJobId,
        sourceContextJobIds,
        enableHistoricalMemory,
        scannedLinks,
        mode,
        depth,
        volumeSplitMode,
        rawUserPrompt,
        customRootFolder,
        autoArchiveDrive,
        attachments,
        driveToken,
        billing: {
          billingMode: settlement.billingMode,
          estimatedPages: estimate.estimatedPages,
          estimatedTokens: estimate.estimatedTotalTokens,
          upstreamApiCostCny: estimate.upstreamApiCostCny,
          chargedCny: settlement.chargedCny,
          grossMarginRate:
            settlement.billingMode === 'monthly_pro_quota'
              ? pricing.monthlyGrossMargin
              : estimate.grossMarginRate,
        },
      });

      res.json({ job, profile: settlement.profile });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
  });

  // Post-Completion Task Expansion (Seamless In-Place Chapter/Problem Expansion OR Derived Companion Task)
  app.post('/api/jobs/:id/expand', async (req: Request, res: Response) => {
    try {
      const sourceJobId = String(req.params.id);
      const {
        expansionMode = 'append_in_place',
        expansionPrompt = '',
        targetDocMode,
        depth = 'comprehensive',
        source = 'text',
        attachments = [],
        scannedLinks = [],
        sourceJobSnapshot,
      } = req.body as {
        expansionMode?: PostCompletionExpansionMode;
        expansionPrompt?: string;
        targetDocMode?: DocMode;
        depth?: DepthPreset;
        source?: 'text' | 'voice';
        attachments?: ServerAttachmentPayload[];
        scannedLinks?: ScannedLinkResult[];
        sourceJobSnapshot?: PipelineJob;
      };

      if (!expansionPrompt.trim() && attachments.length === 0) {
        res.status(400).json({
          error: '请输入继续扩展的具体要求（或选择快捷扩展方向）、语音口述，或上传/粘贴补充资料链接。',
        });
        return;
      }

      const verified = await verifyRequestGoogleUser(req);
      if (!verified) {
        res.status(401).json({
          error: '请先点击右上角登录您的 Google 账号后再执行长上下文扩展任务。',
          code: 'AUTH_REQUIRED',
        });
        return;
      }

      const effectiveMode: DocMode =
        targetDocMode || sourceJobSnapshot?.mode || getServerJob(sourceJobId)?.mode || 'lecture_notes';
      const pricing = getPricingConfig();
      const estimate = estimateTaskTokenAndPrice({
        mode: effectiveMode,
        depth,
        promptLength: expansionPrompt.length + 1200,
        attachments: attachments.map((a) => ({ kind: a.kind, size: a.size || 0 })),
        pricing,
      });

      const targetBillingJobId =
        expansionMode === 'derive_new_job'
          ? `job-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
          : sourceJobId;

      const settlement = authorizeAndSettleJobLaunch({
        email: verified.email,
        jobId: targetBillingJobId,
        jobTitleHint: `[长上下文扩展] ${expansionPrompt.trim().slice(0, 40)}`,
        estimate,
        preferredMethod: 'auto',
      });

      if (!settlement.allowed) {
        res.status(402).json({
          error: settlement.reason || '当前账户余额或周期额度不足',
          code: 'BILLING_REQUIRED',
          estimate,
          profile: settlement.profile,
        });
        return;
      }

      const driveToken = extractBearerToken(req);
      const expandedOrDerivedJob = await expandCompletedServerJob({
        sourceJobId,
        sourceJobSnapshot,
        expansionMode,
        expansionPrompt,
        targetDocMode: effectiveMode,
        depth,
        source,
        attachments,
        scannedLinks,
        driveToken,
        ownerEmail: verified.email,
        ownerUid: verified.uid,
        clientDeviceId: extractClientDeviceId(req),
        newJobId: expansionMode === 'derive_new_job' ? targetBillingJobId : undefined,
        billing: {
          billingMode: settlement.billingMode,
          estimatedPages: estimate.estimatedPages,
          estimatedTokens: estimate.estimatedTotalTokens,
          upstreamApiCostCny: estimate.upstreamApiCostCny,
          chargedCny: settlement.chargedCny,
          grossMarginRate:
            settlement.billingMode === 'monthly_pro_quota'
              ? pricing.monthlyGrossMargin
              : estimate.grossMarginRate,
        },
      });

      res.json({
        job: expandedOrDerivedJob,
        expansionMode,
        profile: settlement.profile,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
  });

  app.post('/api/jobs/resume', async (req: Request, res: Response) => {
    try {
      const {
        job: incomingJob,
        strategy = 'continue',
        targetBatchIndex,
        attachments,
      } = req.body as {
        job?: PipelineJob;
        strategy?: ResumeStrategy;
        targetBatchIndex?: number;
        attachments?: ServerAttachmentPayload[];
      };

      if (!incomingJob || !incomingJob.id) {
        res.status(400).json({ error: '缺少待恢复的任务数据' });
        return;
      }

      const verified = await verifyRequestGoogleUser(req);
      const driveToken = extractBearerToken(req);
      const resumed = resumeDetachedJob({
        incomingJob,
        strategy,
        targetBatchIndex,
        attachments,
        driveToken,
        ownerEmail: verified?.email,
      });

      res.json({ job: resumed });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
  });

  // Live mid-execution supplemental prompt + unlimited attachments + voice dictation injection!
  app.post('/api/jobs/:id/supplement', async (req: Request, res: Response) => {
    try {
      const jobId = String(req.params.id);
      const {
        text = '',
        source = 'text',
        attachments = [],
      } = req.body as {
        text?: string;
        source?: 'text' | 'voice';
        attachments?: ServerAttachmentPayload[];
      };

      if (!text.trim() && attachments.length === 0) {
        res.status(400).json({ error: '请输入补充/修正提示内容或上传补充文件。' });
        return;
      }

      const verified = await verifyRequestGoogleUser(req);
      const driveToken = extractBearerToken(req);
      const updatedJob = appendSupplementalDirectiveToJob({
        jobId,
        text,
        source,
        attachments,
        driveToken,
        ownerEmail: verified?.email,
      });

      res.json({ job: updatedJob });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
  });

  app.post('/api/jobs/:id/cancel', (req: Request, res: Response) => {
    const job = cancelServerJob(String(req.params.id));
    if (!job) {
      res.status(404).json({ error: '未找到该任务' });
      return;
    }
    res.json({ job });
  });

  app.delete('/api/jobs/:id', (req: Request, res: Response) => {
    deleteServerJob(String(req.params.id));
    res.json({ ok: true });
  });

  // On-Demand Local Download ONLY when user explicitly clicks Download (supports single PDF or any individual multi-volume PDF)!
  const serveJobOrVolumePdf = async (req: Request, res: Response, explicitVolumeId?: string) => {
    try {
      const jobId = String(req.params.id);
      const requestedVolId =
        explicitVolumeId ||
        (typeof req.query.volumeId === 'string' ? req.query.volumeId.trim() : undefined);
      const job = getServerJob(jobId);
      if (!job) {
        res.status(404).json({ error: 'JOB_NOT_FOUND' });
        return;
      }
      const token = extractBearerToken(req);
      const pdfBuf = await streamOrCompileJobPdfOnDemand(jobId, token, requestedVolId);
      if (!pdfBuf) {
        res.status(404).json({ error: 'SERVER_PDF_NOT_CACHED' });
        return;
      }
      const matchedVol = requestedVolId
        ? job.outputVolumes?.find((v) => v.volumeId === requestedVolId)
        : undefined;
      const rawFileName =
        matchedVol?.fileName ||
        job.plan?.suggestedFileName ||
        `${job.plan?.documentTitle || 'Carbon_Document'}.pdf`;
      const downloadName = encodeURIComponent(rawFileName);
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${downloadName}`);
      res.send(pdfBuf);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
  };

  app.get('/api/jobs/:id/pdf', async (req: Request, res: Response) => {
    await serveJobOrVolumePdf(req, res);
  });

  app.get('/api/jobs/:id/volumes/:volumeId/pdf', async (req: Request, res: Response) => {
    await serveJobOrVolumePdf(req, res, String(req.params.volumeId));
  });

  app.post('/api/jobs/attach-token', async (req: Request, res: Response) => {
    try {
      const token = extractBearerToken(req);
      if (!token) {
        res.status(400).json({ error: '缺少 Google Cloud / Drive 访问令牌' });
        return;
      }
      const verified = await verifyRequestGoogleUser(req);
      const { jobId, archiveImmediately, jobSnapshot } = req.body as {
        jobId?: string;
        archiveImmediately?: boolean;
        jobSnapshot?: PipelineJob;
      };
      registerDriveToken(token, jobId, verified?.email);

      if (jobId && archiveImmediately) {
        if (!getServerJob(jobId) && jobSnapshot) {
          resumeDetachedJob({
            incomingJob: jobSnapshot,
            strategy: 'continue',
            driveToken: token,
            ownerEmail: verified?.email,
          });
          res.json({ job: getServerJob(jobId) });
          return;
        }
        const archivedJob = await archiveServerJobToDrive(jobId, token);
        res.json({ job: archivedJob });
        return;
      }

      res.json({ ok: true, profile: verified?.profile || null });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
  });

  app.post('/api/jobs/sync-from-drive', async (req: Request, res: Response) => {
    try {
      const token = extractBearerToken(req);
      if (!token) {
        res.status(401).json({ error: '请先登录 Google 账号以从您的个人云盘同步任务。' });
        return;
      }
      const verified = await verifyRequestGoogleUser(req);
      const { rootFolder = 'Carbon 学术归档' } = req.body as { rootFolder?: string };
      const result = await syncJobsFromGoogleDrive(token, rootFolder, verified?.email);
      res.json(result);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
  });

  const distPath = path.resolve(__dirname, 'dist');
  const isProd = process.env.NODE_ENV === 'production' && fs.existsSync(distPath);

  if (isProd) {
    app.use(express.static(distPath));
    app.get('*', (_req: Request, res: Response) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  } else {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  }

  const PORT = Number(process.env.PORT) || 3000;
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Carbon Scholar Studio cloud-runner listening on http://0.0.0.0:${PORT}`);
  });
}

startServer().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
