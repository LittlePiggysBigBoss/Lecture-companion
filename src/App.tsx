import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { User } from 'firebase/auth';
import {
  Activity,
  BookOpenCheck,
  CreditCard,
  FolderArchive,
  History,
  Menu,
  PenTool,
  X,
} from 'lucide-react';
import type {
  ActiveNavTab,
  AdminSystemOverview,
  ColorPaletteTheme,
  DepthPreset,
  DocMode,
  GeneratedVolumeArtifact,
  PageOrientationMode,
  PipelineJob,
  PostCompletionExpansionMode,
  PricingConfig,
  ResumeStrategy,
  ScannedLinkResult,
  UploadedAttachment,
  UserAccountProfile,
  UserCloudConfig,
  VolumeSplitMode,
} from './types';
import { createInitialSeedJobs } from './data/seedHistory';
import {
  archivePdfToGoogleDrive,
  deleteDriveArchivedFile,
  getAccessToken,
  googleSignIn,
  initAuth,
  logout,
} from './services/authDrive';
import {
  buildAuthenticatedHeaders,
  uploadFilesUnlimited,
} from './services/fileAndVoiceClient';
import type { UploadProgressState } from './services/fileAndVoiceClient';
import {
  compileAcademicPdfBlob,
  triggerPdfDownload,
} from './services/pdfGenerator';
import { DEFAULT_PRICING_CONFIG } from './utils/billingAndQuota';
import {
  buildDriveArchivePath,
  isJobActiveStage,
  normalizePdfFileName,
  reconcileJobsWithServer,
} from './utils/pipelineLogic';
import { GoogleSignInButton } from './components/GoogleSignInButton';
import { ComposerPanel } from './components/ComposerPanel';
import { PipelineMonitor } from './components/PipelineMonitor';
import { HistoryPanel } from './components/HistoryPanel';
import { BillingAndCloudPanel } from './components/BillingAndCloudPanel';
import { ConfirmDialog } from './components/ConfirmDialog';

const STORAGE_KEY = 'carbon_scholar_studio_jobs_v1';

function loadInitialJobs(): PipelineJob[] {
  const freshSeeds = createInitialSeedJobs();
  const freshSeedMap = new Map(freshSeeds.map((s) => [s.id, s]));
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as PipelineJob[];
      if (Array.isArray(parsed) && parsed.length > 0) {
        return parsed.map((item) => {
          if (item.id.startsWith('seed-') && freshSeedMap.has(item.id)) {
            return freshSeedMap.get(item.id)!;
          }
          return item;
        });
      }
    }
  } catch {
    // Ignore malformed localStorage
  }
  return freshSeeds;
}

export default function App() {
  const [activeTab, setActiveTab] = useState<ActiveNavTab>('composer');
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  // Google Auth, Account Profile & Pricing State
  const [user, setUser] = useState<User | null>(null);
  const [driveToken, setDriveToken] = useState<string | null>(null);
  const [isSigningIn, setIsSigningIn] = useState(false);
  const [accountProfile, setAccountProfile] = useState<UserAccountProfile | null>(null);
  const [pricingConfig, setPricingConfig] = useState<PricingConfig>(DEFAULT_PRICING_CONFIG);

  // Composer Form State + Multi-Model Palette/Figures + Historical Memory & Link Scanner State
  const [mode, setMode] = useState<DocMode>('lecture_notes');
  const [depth, setDepth] = useState<DepthPreset>('comprehensive');
  const [volumeSplitMode, setVolumeSplitMode] = useState<VolumeSplitMode>('auto');
  const [pageOrientation, setPageOrientation] = useState<PageOrientationMode>('auto');
  const [colorTheme, setColorTheme] = useState<ColorPaletteTheme>('academic_blue');
  const [autoGenerateFigures, setAutoGenerateFigures] = useState(true);
  const [prompt, setPrompt] = useState('');
  const [attachments, setAttachments] = useState<UploadedAttachment[]>([]);
  const [composerScannedLinks, setComposerScannedLinks] = useState<ScannedLinkResult[]>([]);
  const [sourceContextJobIds, setSourceContextJobIds] = useState<string[]>([]);
  const [enableHistoricalMemory, setEnableHistoricalMemory] = useState(true);
  const [composerUploadProgress, setComposerUploadProgress] =
    useState<UploadProgressState | null>(null);
  const [autoArchiveDrive, setAutoArchiveDrive] = useState(true);
  const [customRootFolder, setCustomRootFolder] = useState('Carbon 学术归档');
  const [isParsingFiles, setIsParsingFiles] = useState(false);
  const [validationError, setValidationError] = useState<string | null>(null);

  // Pipeline Jobs & Selected Job State
  const [jobs, setJobs] = useState<PipelineJob[]>(loadInitialJobs);
  const [selectedJobId, setSelectedJobId] = useState<string | null>(() => {
    const initial = loadInitialJobs();
    return initial[0]?.id || null;
  });
  const [isRunningPipeline, setIsRunningPipeline] = useState(false);
  const [activeServerJobIds, setActiveServerJobIds] = useState<string[]>([]);
  const [isResumingJobId, setIsResumingJobId] = useState<string | null>(null);
  const [isSubmittingSupplement, setIsSubmittingSupplement] = useState(false);
  const [isExpandingJob, setIsExpandingJob] = useState(false);
  const [isSyncingFromDrive, setIsSyncingFromDrive] = useState(false);
  const [isCompilingPdfJobId, setIsCompilingPdfJobId] = useState<string | null>(null);
  const [compilingVolumeKey, setCompilingVolumeKey] = useState<string | null>(null);
  const [pdfCompileProgress, setPdfCompileProgress] = useState<{
    current: number;
    total: number;
  } | null>(null);
  const [isUploadingDriveJobId, setIsUploadingDriveJobId] = useState<string | null>(null);
  const [jobPendingDelete, setJobPendingDelete] = useState<PipelineJob | null>(null);
  const [bannerNotice, setBannerNotice] = useState<{
    tone: 'info' | 'error' | 'success';
    text: string;
  } | null>(null);

  const pdfCacheRef = useRef<Map<string, { blob: Blob; fileName: string }>>(new Map());
  const driveTokenRef = useRef<string | null>(null);
  const hasInitialServerSyncRef = useRef(false);
  driveTokenRef.current = driveToken;

  // Persist lightweight job index to localStorage
  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(jobs));
    } catch {
      // Ignore storage quota warnings
    }
  }, [jobs]);

  const syncAccountProfile = useCallback(async (explicitToken?: string | null) => {
    try {
      const headers = await buildAuthenticatedHeaders(
        explicitToken || driveTokenRef.current
      );
      const resp = await fetch('/api/account/me', { headers });
      if (!resp.ok) return;
      const data = (await resp.json()) as {
        profile?: UserAccountProfile | null;
        pricing?: PricingConfig;
      };
      if (data.pricing) {
        setPricingConfig(data.pricing);
      }
      if (data.profile !== undefined) {
        setAccountProfile(data.profile);
        if (data.profile?.cloudConfig?.driveRootFolder) {
          setCustomRootFolder((prev) =>
            prev === 'Carbon 学术归档' ? data.profile!.cloudConfig.driveRootFolder : prev
          );
        }
      }
    } catch {
      // Ignore transient network errors
    }
  }, []);

  const syncWithServerJobs = useCallback(async (explicitToken?: string | null) => {
    try {
      const headers = await buildAuthenticatedHeaders(
        explicitToken || driveTokenRef.current
      );
      const resp = await fetch('/api/jobs', { headers });
      if (!resp.ok) return;
      const data = (await resp.json()) as {
        jobs?: PipelineJob[];
        activeJobIds?: string[];
      };
      const serverJobs = Array.isArray(data.jobs) ? data.jobs : [];
      const activeIds = Array.isArray(data.activeJobIds) ? data.activeJobIds : [];

      setActiveServerJobIds(activeIds);
      setJobs((prevLocal) => reconcileJobsWithServer(prevLocal, serverJobs, activeIds));
      if (serverJobs.length > 0 && !hasInitialServerSyncRef.current) {
        hasInitialServerSyncRef.current = true;
        const firstActive = serverJobs.find((j) => isJobActiveStage(j.stage)) || serverJobs[0];
        setSelectedJobId((prevId) =>
          !prevId || prevId.startsWith('seed-') ? firstActive.id : prevId
        );
      }
    } catch {
      // Transient client network fluctuation: server jobs continue unaffected in background!
    }
  }, []);

  // Initial sync on mount + multi-device sync when tab regains focus or network reconnects
  useEffect(() => {
    void syncAccountProfile();
    void syncWithServerJobs();
    const onVisibilityOrOnline = () => {
      if (document.visibilityState === 'visible') {
        void syncAccountProfile();
        void syncWithServerJobs();
      }
    };
    document.addEventListener('visibilitychange', onVisibilityOrOnline);
    window.addEventListener('online', onVisibilityOrOnline);
    return () => {
      document.removeEventListener('visibilitychange', onVisibilityOrOnline);
      window.removeEventListener('online', onVisibilityOrOnline);
    };
  }, [syncAccountProfile, syncWithServerJobs]);

  const mainViewportRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    mainViewportRef.current?.scrollTo({ top: 0 });
    window.scrollTo({ top: 0 });
  }, [activeTab, selectedJobId]);

  const hasAnyActiveJob =
    activeServerJobIds.length > 0 || jobs.some((j) => isJobActiveStage(j.stage));

  // Poll live background progress (every 1.4s while active, every 8s idle for multi-device sync)
  useEffect(() => {
    const intervalMs = hasAnyActiveJob ? 1400 : 8000;
    const timer = window.setInterval(() => {
      void syncWithServerJobs();
    }, intervalMs);
    return () => window.clearInterval(timer);
  }, [hasAnyActiveJob, syncWithServerJobs]);

  // Initialize Firebase Google Auth listener (restores account identity across reloads for multi-device sync)
  useEffect(() => {
    const unsubscribe = initAuth(
      (authedUser, token) => {
        setUser(authedUser);
        setDriveToken(token);
        void syncAccountProfile(token);
        void syncWithServerJobs(token);
      },
      (maybeUser) => {
        setUser(maybeUser ?? null);
        setDriveToken(null);
        if (maybeUser) {
          void syncAccountProfile(null);
          void syncWithServerJobs(null);
        }
      }
    );
    return () => unsubscribe();
  }, [syncAccountProfile, syncWithServerJobs]);

  const updateJobById = useCallback(
    (jobId: string, updater: (prev: PipelineJob) => PipelineJob) => {
      setJobs((prevList) =>
        prevList.map((item) => (item.id === jobId ? updater(item) : item))
      );
    },
    []
  );

  const handleGoogleSignIn = async (): Promise<string | null> => {
    setIsSigningIn(true);
    setBannerNotice(null);
    try {
      const res = await googleSignIn();
      setUser(res.user);
      setDriveToken(res.accessToken);
      if (res.accessToken) {
        const headers = await buildAuthenticatedHeaders(res.accessToken, true);
        fetch('/api/jobs/attach-token', {
          method: 'POST',
          headers,
          body: JSON.stringify({}),
        }).catch(() => {});
        await syncAccountProfile(res.accessToken);
        await syncWithServerJobs(res.accessToken);
      }
      return res.accessToken;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!msg.includes('popup-closed-by-user')) {
        setBannerNotice({
          tone: 'error',
          text: `Google 登录授权未完成：${msg}`,
        });
      }
      return null;
    } finally {
      setIsSigningIn(false);
    }
  };

  const handleGoogleSignOut = async () => {
    await logout();
    setUser(null);
    setDriveToken(null);
    setAccountProfile(null);
    setBannerNotice({
      tone: 'info',
      text: '已退出当前 Google 账号。重新登录后即可恢复多终端任务同步与个人云归档。',
    });
  };

  // Unlimited-Size Chunked Multimodal Attachment Handler
  const handleAddAttachments = async (incomingFiles: FileList | File[]) => {
    const fileArray = Array.from(incomingFiles);
    if (fileArray.length === 0) return;

    setIsParsingFiles(true);
    setValidationError(null);
    setBannerNotice(null);

    try {
      const uploadedItems = await uploadFilesUnlimited(
        fileArray,
        setComposerUploadProgress
      );
      setAttachments((prev) => [...prev, ...uploadedItems]);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setBannerNotice({ tone: 'error', text: msg });
    } finally {
      setIsParsingFiles(false);
      setComposerUploadProgress(null);
    }
  };

  const handleRemoveAttachment = (id: string) => {
    setAttachments((prev) => prev.filter((a) => a.id !== id));
  };

  const handleIngestScannedAttachments = useCallback((items: UploadedAttachment[]) => {
    if (items.length === 0) return;
    setAttachments((prev) => {
      const existingServerIds = new Set(prev.map((a) => a.serverFileId).filter(Boolean));
      const existingNames = new Set(prev.map((a) => `${a.name}:${a.size}`));
      const fresh = items.filter((item) => {
        if (item.serverFileId && existingServerIds.has(item.serverFileId)) return false;
        if (existingNames.has(`${item.name}:${item.size}`)) return false;
        return true;
      });
      return fresh.length > 0 ? [...prev, ...fresh] : prev;
    });
  }, []);

  const handleToggleSourceContextJobId = useCallback((jobId: string) => {
    setSourceContextJobIds((prev) =>
      prev.includes(jobId) ? prev.filter((id) => id !== jobId) : [...prev, jobId]
    );
  }, []);

  const handleClearSourceContextJobs = useCallback(() => {
    setSourceContextJobIds([]);
  }, []);

  const handleLoadIntoComposerWithMemory = useCallback(
    (sourceJob: PipelineJob, suggestedMode: DocMode) => {
      const sourceTitle =
        sourceJob.plan?.documentTitle || sourceJob.rawUserPrompt.slice(0, 32) || '已完成文档';
      setMode(suggestedMode);
      setEnableHistoricalMemory(true);
      setSourceContextJobIds((prev) =>
        prev.includes(sourceJob.id) ? prev : [sourceJob.id, ...prev]
      );
      setPrompt((prev) =>
        prev.trim()
          ? prev
          : suggestedMode === 'workbook'
            ? `请完整继承已绑定文档《${sourceTitle}》的全部章节结构、核心公式记号与难度梯度，派生编制一份完全配套的分级练习题册（含每道题详尽分步推导与评分标准）。`
            : `请完整继承已绑定文档《${sourceTitle}》的知识脉络与符号约定，继续深层扩编后续专题章节与综合例题讲义。`
      );
      setActiveTab('composer');
      setBannerNotice({
        tone: 'info',
        text: `已将《${sourceTitle}》（${sourceJob.charCount.toLocaleString()} 字）挂载为长上下文历史记忆基准，您可自由补充要求或粘贴云盘链接后启动。`,
      });
    },
    []
  );

  const ensureJobPdfBlob = async (
    job: PipelineJob
  ): Promise<{ blob: Blob; fileName: string }> => {
    const existing = pdfCacheRef.current.get(job.id);
    if (existing) {
      return existing;
    }

    setIsCompilingPdfJobId(job.id);
    setPdfCompileProgress(null);
    try {
      const compiled = await compileAcademicPdfBlob(job, (current, total) => {
        setPdfCompileProgress({ current, total });
      });
      pdfCacheRef.current.set(job.id, {
        blob: compiled.blob,
        fileName: compiled.fileName,
      });
      updateJobById(job.id, (prev) => ({
        ...prev,
        estimatedPages: compiled.pageCount,
      }));
      return { blob: compiled.blob, fileName: compiled.fileName };
    } finally {
      setIsCompilingPdfJobId(null);
      setPdfCompileProgress(null);
    }
  };

  const handleDownloadVolumePdf = async (
    job: PipelineJob,
    volume: GeneratedVolumeArtifact
  ): Promise<void> => {
    const cacheKey = `${job.id}__${volume.volumeId}`;
    const volKey = `${job.id}:${volume.volumeId}`;
    setCompilingVolumeKey(volKey);
    try {
      setBannerNotice(null);
      const cached = pdfCacheRef.current.get(cacheKey);
      if (cached) {
        triggerPdfDownload(cached.blob, volume.fileName);
        return;
      }

      if (volume.serverPdfReady || job.executionHost === 'server_cloud') {
        const headers = await buildAuthenticatedHeaders(driveToken);
        const serverRes = await fetch(
          `/api/jobs/${encodeURIComponent(job.id)}/volumes/${encodeURIComponent(
            volume.volumeId
          )}/pdf`,
          { headers }
        );
        if (serverRes.ok) {
          const blob = await serverRes.blob();
          pdfCacheRef.current.set(cacheKey, { blob, fileName: volume.fileName });
          triggerPdfDownload(blob, volume.fileName);
          return;
        }
      }

      const compiled = await compileAcademicPdfBlob(
        job,
        (current, total) => {
          setPdfCompileProgress({ current, total });
        },
        volume
      );
      pdfCacheRef.current.set(cacheKey, {
        blob: compiled.blob,
        fileName: compiled.fileName,
      });
      triggerPdfDownload(compiled.blob, compiled.fileName);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setBannerNotice({
        tone: 'error',
        text: `下载分册《${volume.volumeTitle}》PDF 失败：${msg}`,
      });
    } finally {
      setCompilingVolumeKey(null);
      setPdfCompileProgress(null);
    }
  };

  const handleDownloadAllVolumes = async (job: PipelineJob): Promise<void> => {
    const readyVolumes = (job.outputVolumes || []).filter(
      (v) => v.compiledMarkdown.trim().length > 0
    );
    if (readyVolumes.length <= 1) {
      if (readyVolumes.length === 1) {
        await handleDownloadVolumePdf(job, readyVolumes[0]);
      }
      return;
    }

    setIsCompilingPdfJobId(job.id);
    try {
      for (let i = 0; i < readyVolumes.length; i++) {
        await handleDownloadVolumePdf(job, readyVolumes[i]);
        if (i < readyVolumes.length - 1) {
          await new Promise((r) => window.setTimeout(r, 340));
        }
      }
      setBannerNotice({
        tone: 'success',
        text: `已按需依次导出全部 ${readyVolumes.length} 份独立分册 PDF 文件到本地！`,
      });
    } finally {
      setIsCompilingPdfJobId(null);
    }
  };

  // Explicit On-Demand Local Download ONLY when user clicks Download button!
  const handleDownloadPdf = async (job: PipelineJob) => {
    if (job.outputVolumes && job.outputVolumes.length > 1) {
      await handleDownloadAllVolumes(job);
      return;
    }

    try {
      setBannerNotice(null);
      const suggestedName = normalizePdfFileName(
        job.plan?.suggestedFileName || `${job.plan?.documentTitle || 'Carbon_学术文档'}.pdf`,
        job.mode
      );

      if (job.serverPdfReady || job.executionHost === 'server_cloud') {
        const headers = await buildAuthenticatedHeaders(driveToken);
        const serverPdfRes = await fetch(
          `/api/jobs/${encodeURIComponent(job.id)}/pdf`,
          { headers }
        );
        if (serverPdfRes.ok) {
          const blob = await serverPdfRes.blob();
          pdfCacheRef.current.set(job.id, { blob, fileName: suggestedName });
          triggerPdfDownload(blob, suggestedName);
          return;
        }
      }

      const { blob, fileName } = await ensureJobPdfBlob(job);
      triggerPdfDownload(blob, fileName);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setBannerNotice({ tone: 'error', text: `按需拉取导出 PDF 失败：${msg}` });
    }
  };

  const handleSyncJobToDrive = async (
    job: PipelineJob,
    explicitToken?: string
  ): Promise<void> => {
    let activeToken = explicitToken || getAccessToken() || driveToken;
    if (!activeToken) {
      activeToken = await handleGoogleSignIn();
      if (!activeToken) return;
    }

    setIsUploadingDriveJobId(job.id);
    updateJobById(job.id, (prev) => ({
      ...prev,
      driveArchive: {
        ...prev.driveArchive,
        status: 'uploading',
        error: undefined,
      },
    }));

    try {
      const headers = await buildAuthenticatedHeaders(activeToken, true);
      const serverResp = await fetch('/api/jobs/attach-token', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          jobId: job.id,
          archiveImmediately: true,
          jobSnapshot: job,
        }),
      });

      if (serverResp.ok) {
        const serverData = (await serverResp.json()) as { job?: PipelineJob };
        if (serverData.job) {
          const updatedJob = serverData.job;
          setJobs((prev) =>
            prev.some((j) => j.id === updatedJob.id)
              ? prev.map((j) => (j.id === updatedJob.id ? updatedJob : j))
              : [updatedJob, ...prev]
          );

          if (isJobActiveStage(updatedJob.stage)) {
            setActiveServerJobIds((prev) =>
              prev.includes(updatedJob.id) ? prev : [...prev, updatedJob.id]
            );
            setBannerNotice({
              tone: 'info',
              text: '云端后台正在编译矢量 PDF 并直传至您个人的 Google Cloud...',
            });
            return;
          }

          if (updatedJob.driveArchive.status === 'archived') {
            setBannerNotice({
              tone: 'success',
              text: `已托管至您个人的 Google Cloud：「${updatedJob.driveArchive.folderPath}」（仅点击下载时保存到本地）`,
            });
            return;
          }
        }
      }

      const { blob, fileName } = await ensureJobPdfBlob(job);
      const folderSpec = buildDriveArchivePath({
        rootFolder: job.plan?.archiveRootFolder || job.customRootFolder,
        subjectCategory: job.plan?.subjectCategory,
        mode: job.mode,
      });

      const uploaded = await archivePdfToGoogleDrive({
        accessToken: activeToken,
        pdfBlob: blob,
        fileName: normalizePdfFileName(fileName, job.mode),
        rootFolder: folderSpec.root,
        subjectFolder: folderSpec.subject,
        categoryFolder: folderSpec.category,
        description: job.plan?.subtitle || job.rawUserPrompt,
      });

      updateJobById(job.id, (prev) => ({
        ...prev,
        updatedAt: new Date().toISOString(),
        driveArchive: {
          ...prev.driveArchive,
          status: 'archived',
          folderPath: uploaded.folderPath,
          fileId: uploaded.fileId,
          webViewLink: uploaded.webViewLink,
          archivedAt: new Date().toISOString(),
        },
      }));

      setBannerNotice({
        tone: 'success',
        text: `已存入您个人的 Google Cloud：「${uploaded.folderPath}」`,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg === 'AUTH_EXPIRED' || msg.includes('401')) {
        setDriveToken(null);
        updateJobById(job.id, (prev) => ({
          ...prev,
          driveArchive: {
            ...prev.driveArchive,
            status: 'pending_auth',
            error: 'Google 授权已过期，请重新点击连接个人云归档',
          },
        }));
      } else {
        updateJobById(job.id, (prev) => ({
          ...prev,
          driveArchive: {
            ...prev.driveArchive,
            status: 'error',
            error: msg,
          },
        }));
        setBannerNotice({ tone: 'error', text: msg });
      }
    } finally {
      setIsUploadingDriveJobId(null);
    }
  };

  // Launch Detached Background Job on Server (with Historical Memory, Link Scanning, Account Sync & Billing)
  const handleSubmitPipeline = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!prompt.trim() && attachments.length === 0 && sourceContextJobIds.length === 0) {
      setValidationError('请输入讲义/练习题册的主题要求、粘贴云盘/网页链接、使用语音录入，或上传至少一份参考文件后再启动。');
      return;
    }

    setValidationError(null);
    setBannerNotice(null);
    setIsRunningPipeline(true);

    try {
      let activeToken = getAccessToken() || driveToken;
      if (!user && !activeToken) {
        activeToken = await handleGoogleSignIn();
        if (!activeToken) {
          setIsRunningPipeline(false);
          return;
        }
      }

      const headers = await buildAuthenticatedHeaders(activeToken, true);
      const resp = await fetch('/api/jobs/start', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          mode,
          depth,
          volumeSplitMode,
          pageOrientation,
          colorTheme,
          autoGenerateFigures,
          rawUserPrompt: prompt.trim(),
          customRootFolder: customRootFolder.trim() || 'Carbon 学术归档',
          autoArchiveDrive,
          parentJobId: sourceContextJobIds[0] || undefined,
          sourceContextJobIds,
          enableHistoricalMemory,
          scannedLinks: composerScannedLinks,
          attachments: attachments.map((a) => ({
            name: a.name,
            mimeType: a.mimeType,
            kind: a.kind,
            size: a.size,
            base64Data: a.base64Data,
            extractedText: a.extractedText,
            serverFileId: a.serverFileId,
            fileUri: a.fileUri,
          })),
        }),
      });

      const payload = (await resp.json()) as {
        job?: PipelineJob;
        profile?: UserAccountProfile;
        code?: string;
        error?: string;
      };

      if (resp.status === 402 || payload.code === 'BILLING_REQUIRED') {
        if (payload.profile) setAccountProfile(payload.profile);
        setActiveTab('billing_admin');
        setBannerNotice({
          tone: 'error',
          text: payload.error || '当前账户余额或窗口配额不足，请先充值按页额度或开通 ¥300/月 包月会员。',
        });
        return;
      }

      if (!resp.ok || !payload.job) {
        throw new Error(payload.error || '启动云端后台生成任务失败');
      }

      if (payload.profile) {
        setAccountProfile(payload.profile);
      }

      const launchedJob = payload.job;
      setJobs((prev) => [launchedJob, ...prev.filter((j) => j.id !== launchedJob.id)]);
      setActiveServerJobIds((prev) =>
        prev.includes(launchedJob.id) ? prev : [...prev, launchedJob.id]
      );
      setSelectedJobId(launchedJob.id);
      setActiveTab('monitor');
      setPrompt('');
      setVolumeSplitMode('auto');
      setPageOrientation('auto');
      setAttachments([]);
      setComposerScannedLinks([]);
      setSourceContextJobIds([]);
      setBannerNotice({
        tone: 'info',
        text:
          launchedJob.outputVolumes && launchedJob.outputVolumes.length > 1
            ? `已识别分册需求并启动云端后台自适应工作流：将独立生成 ${launchedJob.outputVolumes.length} 份 PDF 文件，运行中可随时追加或变更要求！`
            : '任务已挂载至您的个人云后台独立执行：已启用强历史记忆、单次调用极限动态排程与分册自动识别！',
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setBannerNotice({ tone: 'error', text: msg });
    } finally {
      setIsRunningPipeline(false);
    }
  };

  // Post-Completion Task Expansion (In-Place Seamless Chapter/Problem Continuation OR Derived New Companion Job)
  const handleExpandCompletedJob = async (params: {
    sourceJob: PipelineJob;
    expansionMode: PostCompletionExpansionMode;
    expansionPrompt: string;
    targetDocMode: DocMode;
    depth: DepthPreset;
    source: 'text' | 'voice';
    attachments: UploadedAttachment[];
    scannedLinks: ScannedLinkResult[];
  }): Promise<void> => {
    setIsExpandingJob(true);
    setBannerNotice(null);

    try {
      let activeToken = getAccessToken() || driveToken;
      if (!user && !activeToken) {
        activeToken = await handleGoogleSignIn();
        if (!activeToken) {
          setIsExpandingJob(false);
          return;
        }
      }

      const sendExpandRequest = async (tokenToUse: string | null) => {
        const headers = await buildAuthenticatedHeaders(tokenToUse, true);
        return fetch(`/api/jobs/${encodeURIComponent(params.sourceJob.id)}/expand`, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            expansionMode: params.expansionMode,
            expansionPrompt: params.expansionPrompt,
            targetDocMode: params.targetDocMode,
            depth: params.depth,
            source: params.source,
            scannedLinks: params.scannedLinks,
            sourceJobSnapshot: params.sourceJob,
            attachments: params.attachments.map((a) => ({
              name: a.name,
              mimeType: a.mimeType,
              kind: a.kind,
              size: a.size,
              base64Data: a.base64Data,
              extractedText: a.extractedText,
              serverFileId: a.serverFileId,
              fileUri: a.fileUri,
            })),
          }),
        });
      };

      let resp = await sendExpandRequest(activeToken);
      if (resp.status === 401) {
        const refreshedToken = await handleGoogleSignIn();
        if (!refreshedToken) return;
        resp = await sendExpandRequest(refreshedToken);
      }

      const payload = (await resp.json()) as {
        job?: PipelineJob;
        expansionMode?: PostCompletionExpansionMode;
        profile?: UserAccountProfile;
        code?: string;
        error?: string;
      };

      if (resp.status === 402 || payload.code === 'BILLING_REQUIRED') {
        if (payload.profile) setAccountProfile(payload.profile);
        setActiveTab('billing_admin');
        setBannerNotice({
          tone: 'error',
          text:
            payload.error ||
            '当前账户余额或窗口配额不足，请先充值按页额度或开通 ¥300/月 包月会员后再执行扩展。',
        });
        return;
      }

      if (!resp.ok || !payload.job) {
        throw new Error(payload.error || '启动已完成任务扩展失败');
      }

      if (payload.profile) {
        setAccountProfile(payload.profile);
      }

      const resultJob = payload.job;
      pdfCacheRef.current.delete(resultJob.id);
      setJobs((prev) =>
        prev.some((j) => j.id === resultJob.id)
          ? prev.map((j) => (j.id === resultJob.id ? resultJob : j))
          : [resultJob, ...prev]
      );
      setActiveServerJobIds((prev) =>
        prev.includes(resultJob.id) ? prev : [...prev, resultJob.id]
      );
      setSelectedJobId(resultJob.id);
      setActiveTab('monitor');
      setBannerNotice({
        tone: 'success',
        text:
          params.expansionMode === 'append_in_place'
            ? '已基于已完成全文长上下文启动原文档末尾无缝续编：新章节生成完毕后将自动重新合编整本 PDF 并更新云端归档！'
            : `已基于《${
                params.sourceJob.plan?.documentTitle || '原文档'
              }》全量历史记忆派生新任务，正在云端独立生成！`,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setBannerNotice({ tone: 'error', text: msg });
    } finally {
      setIsExpandingJob(false);
    }
  };

  // Live Mid-Execution Supplemental Prompt + Unlimited Attachments + Voice Injection!
  const handleSupplementJob = async (params: {
    jobId: string;
    text: string;
    source: 'text' | 'voice';
    attachments: UploadedAttachment[];
  }): Promise<void> => {
    setIsSubmittingSupplement(true);
    setBannerNotice(null);
    try {
      const headers = await buildAuthenticatedHeaders(driveToken, true);
      const resp = await fetch(
        `/api/jobs/${encodeURIComponent(params.jobId)}/supplement`,
        {
          method: 'POST',
          headers,
          body: JSON.stringify({
            text: params.text,
            source: params.source,
            attachments: params.attachments.map((a) => ({
              name: a.name,
              mimeType: a.mimeType,
              kind: a.kind,
              size: a.size,
              serverFileId: a.serverFileId,
              fileUri: a.fileUri,
            })),
          }),
        }
      );

      const data = (await resp.json()) as { job?: PipelineJob; error?: string };
      if (!resp.ok || !data.job) {
        throw new Error(data.error || '注入补充要求失败');
      }

      const updatedJob = data.job;
      pdfCacheRef.current.delete(updatedJob.id);
      setJobs((prev) =>
        prev.some((j) => j.id === updatedJob.id)
          ? prev.map((j) => (j.id === updatedJob.id ? updatedJob : j))
          : [updatedJob, ...prev]
      );
      if (isJobActiveStage(updatedJob.stage)) {
        setActiveServerJobIds((prev) =>
          prev.includes(updatedJob.id) ? prev : [...prev, updatedJob.id]
        );
      }

      setBannerNotice({
        tone: 'success',
        text: '补充要求、链接扫描与参考附件已无感注入云端任务流，未中断当前执行进度！',
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setBannerNotice({ tone: 'error', text: msg });
    } finally {
      setIsSubmittingSupplement(false);
    }
  };

  const handleResumeJob = async (
    job: PipelineJob,
    strategy: ResumeStrategy,
    targetBatchIndex?: number
  ): Promise<void> => {
    setIsResumingJobId(job.id);
    setBannerNotice(null);

    try {
      const headers = await buildAuthenticatedHeaders(driveToken, true);
      const resp = await fetch('/api/jobs/resume', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          job,
          strategy,
          targetBatchIndex,
        }),
      });

      const payload = (await resp.json()) as { job?: PipelineJob; error?: string };
      if (!resp.ok || !payload.job) {
        throw new Error(payload.error || '恢复任务执行失败');
      }

      const resumedJob = payload.job;
      pdfCacheRef.current.delete(resumedJob.id);
      setJobs((prev) =>
        prev.some((j) => j.id === resumedJob.id)
          ? prev.map((j) => (j.id === resumedJob.id ? resumedJob : j))
          : [resumedJob, ...prev]
      );
      setActiveServerJobIds((prev) =>
        prev.includes(resumedJob.id) ? prev : [...prev, resumedJob.id]
      );
      setSelectedJobId(resumedJob.id);
      setActiveTab('monitor');
      setBannerNotice({
        tone: 'info',
        text:
          strategy === 'continue'
            ? '已启动云端断点续跑：保留全部已完成内容并从中断位置无缝继续撰写。'
            : '已启动单步重跑：保留先前已完成章节，正在重新生成指定批次。',
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setBannerNotice({ tone: 'error', text: `恢复任务失败：${msg}` });
    } finally {
      setIsResumingJobId(null);
    }
  };

  const handleSyncFromDrive = async (): Promise<void> => {
    let activeToken = getAccessToken() || driveToken;
    if (!activeToken) {
      activeToken = await handleGoogleSignIn();
      if (!activeToken) return;
    }

    setIsSyncingFromDrive(true);
    setBannerNotice(null);
    try {
      const headers = await buildAuthenticatedHeaders(activeToken, true);
      const resp = await fetch('/api/jobs/sync-from-drive', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          rootFolder: customRootFolder.trim() || 'Carbon 学术归档',
        }),
      });
      const data = (await resp.json()) as {
        syncedCount?: number;
        jobs?: PipelineJob[];
        error?: string;
      };
      if (!resp.ok) {
        throw new Error(data.error || '从个人 Google Cloud 同步快照失败');
      }
      if (Array.isArray(data.jobs)) {
        setJobs((prev) => reconcileJobsWithServer(prev, data.jobs!, activeServerJobIds));
      }
      setBannerNotice({
        tone: 'success',
        text:
          (data.syncedCount || 0) > 0
            ? `已从您的个人 Google Cloud 同步恢复 ${data.syncedCount} 个任务记录。`
            : '您的个人云端任务快照已与当前设备面板保持最新同步。',
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setBannerNotice({ tone: 'error', text: msg });
    } finally {
      setIsSyncingFromDrive(false);
    }
  };

  // Billing, Personal Cloud Config & Super Admin Handlers
  const handleTopUpWallet = async (amountCny: number) => {
    const headers = await buildAuthenticatedHeaders(driveToken, true);
    const resp = await fetch('/api/billing/topup', {
      method: 'POST',
      headers,
      body: JSON.stringify({ amountCny }),
    });
    const data = (await resp.json()) as { profile?: UserAccountProfile; error?: string };
    if (!resp.ok || !data.profile) {
      setBannerNotice({ tone: 'error', text: data.error || '充值失败' });
      return;
    }
    setAccountProfile(data.profile);
    setBannerNotice({
      tone: 'success',
      text: `按次钱包已成功充值 ¥${amountCny.toFixed(2)}，当前余额 ¥${data.profile.walletBalanceCny.toFixed(2)}。`,
    });
  };

  const handleSubscribeMonthly = async () => {
    const headers = await buildAuthenticatedHeaders(driveToken, true);
    const resp = await fetch('/api/billing/subscribe-monthly', {
      method: 'POST',
      headers,
      body: JSON.stringify({ useWalletIfEnough: true }),
    });
    const data = (await resp.json()) as { profile?: UserAccountProfile; error?: string };
    if (!resp.ok || !data.profile) {
      setBannerNotice({ tone: 'error', text: data.error || '开通包月会员失败' });
      return;
    }
    setAccountProfile(data.profile);
    setBannerNotice({
      tone: 'success',
      text: `已成功开通 ¥${pricingConfig.monthlyPriceCny}/月 包月会员！有效期内享每 6 小时与每周滚动配额。`,
    });
  };

  const handleSaveCloudConfig = async (patch: Partial<UserCloudConfig>) => {
    const headers = await buildAuthenticatedHeaders(driveToken, true);
    const resp = await fetch('/api/account/cloud-config', {
      method: 'POST',
      headers,
      body: JSON.stringify(patch),
    });
    const data = (await resp.json()) as { profile?: UserAccountProfile; error?: string };
    if (!resp.ok || !data.profile) {
      setBannerNotice({ tone: 'error', text: data.error || '保存云端配置失败' });
      return;
    }
    setAccountProfile(data.profile);
    if (data.profile.cloudConfig.driveRootFolder) {
      setCustomRootFolder(data.profile.cloudConfig.driveRootFolder);
    }
    setBannerNotice({
      tone: 'success',
      text: '已保存您个人的 Google Cloud 托管与按需下载策略设置。',
    });
  };

  const handleFetchAdminOverview = useCallback(async (): Promise<AdminSystemOverview | null> => {
    const headers = await buildAuthenticatedHeaders(driveTokenRef.current);
    const resp = await fetch('/api/admin/overview', { headers });
    if (!resp.ok) return null;
    const data = (await resp.json()) as { overview?: AdminSystemOverview };
    return data.overview || null;
  }, []);

  const handleAdminUpdatePricing = async (patch: Partial<PricingConfig>) => {
    const headers = await buildAuthenticatedHeaders(driveToken, true);
    const resp = await fetch('/api/admin/pricing', {
      method: 'POST',
      headers,
      body: JSON.stringify(patch),
    });
    const data = (await resp.json()) as { pricing?: PricingConfig; error?: string };
    if (!resp.ok || !data.pricing) {
      setBannerNotice({ tone: 'error', text: data.error || '更新收费标准失败' });
      return;
    }
    setPricingConfig(data.pricing);
    setBannerNotice({ tone: 'success', text: '全局收费与毛利配额参数已即时生效。' });
  };

  const handleAdminGrantUser = async (params: {
    targetEmail: string;
    addBalanceCny: number;
    grantMonthlyDays: number;
  }): Promise<AdminSystemOverview | null> => {
    const headers = await buildAuthenticatedHeaders(driveToken, true);
    const resp = await fetch('/api/admin/grant', {
      method: 'POST',
      headers,
      body: JSON.stringify(params),
    });
    const data = (await resp.json()) as {
      overview?: AdminSystemOverview;
      error?: string;
    };
    if (!resp.ok) {
      setBannerNotice({ tone: 'error', text: data.error || '发放用户权益失败' });
      return null;
    }
    setBannerNotice({
      tone: 'success',
      text: `已成功为账号 ${params.targetEmail} 发放额度/会员天数。`,
    });
    return data.overview || null;
  };

  const handleCancelRunningJob = async () => {
    const current = jobs.find((j) => j.id === selectedJobId) || jobs[0];
    if (!current) return;
    try {
      const resp = await fetch(`/api/jobs/${encodeURIComponent(current.id)}/cancel`, {
        method: 'POST',
      });
      if (resp.ok) {
        const data = (await resp.json()) as { job?: PipelineJob };
        if (data.job) {
          updateJobById(current.id, () => data.job!);
        }
      } else {
        updateJobById(current.id, (prev) => ({
          ...prev,
          stage: 'cancelled',
          updatedAt: new Date().toISOString(),
        }));
      }
      setActiveServerJobIds((prev) => prev.filter((id) => id !== current.id));
    } catch {
      // Ignore
    }
  };

  const handleConfirmDeleteJob = async (alsoDeleteDriveCopy: boolean) => {
    const target = jobPendingDelete;
    if (!target) return;
    setJobPendingDelete(null);

    fetch(`/api/jobs/${encodeURIComponent(target.id)}`, {
      method: 'DELETE',
    }).catch(() => {});

    if (
      alsoDeleteDriveCopy &&
      target.driveArchive.fileId &&
      (getAccessToken() || driveToken)
    ) {
      try {
        await deleteDriveArchivedFile(
          (getAccessToken() || driveToken)!,
          target.driveArchive.fileId
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        setBannerNotice({ tone: 'error', text: msg });
      }
    }

    pdfCacheRef.current.delete(target.id);
    setActiveServerJobIds((prev) => prev.filter((id) => id !== target.id));
    setJobs((prev) => {
      const remaining = prev.filter((j) => j.id !== target.id);
      if (selectedJobId === target.id) {
        setSelectedJobId(remaining[0]?.id || null);
      }
      return remaining;
    });
  };

  const selectedJob = jobs.find((j) => j.id === selectedJobId) || jobs[0] || null;
  const activeRunningCount = jobs.filter((j) => isJobActiveStage(j.stage)).length;

  const navItems: Array<{
    key: ActiveNavTab;
    label: string;
    icon: React.FC<{ className?: string }>;
    count?: number;
  }> = [
    { key: 'composer', label: '新建讲义与题册', icon: PenTool },
    {
      key: 'monitor',
      label: '实时流水线与预览',
      icon: Activity,
      count: activeRunningCount > 0 ? activeRunningCount : undefined,
    },
    {
      key: 'history',
      label: '多端历史与云归档',
      icon: History,
      count: jobs.length,
    },
    {
      key: 'billing_admin',
      label: accountProfile?.isSuperAdmin ? '云托管与超管后台' : '云端托管与计费',
      icon: CreditCard,
    },
  ];

  const currentBreadcrumbLabel =
    activeTab === 'composer'
      ? '新建讲义与题册'
      : activeTab === 'monitor'
        ? '实时流水线、补充修正与 A4 预览'
        : activeTab === 'history'
          ? '多终端任务同步与个人云归档'
          : accountProfile?.isSuperAdmin
            ? '个人云托管、计费标准与超级管理员后台'
            : '个人云托管、按页计费与包月配额';

  return (
    <div className="min-h-screen flex bg-slate-50 text-slate-900">
      {/* Desktop Sidebar Navigation (256px sticky viewport height) */}
      <aside className="hidden lg:flex lg:flex-col lg:w-64 lg:sticky lg:top-0 lg:h-screen bg-white border-r border-slate-200 shrink-0 no-print">
        <div className="h-16 px-5 flex items-center gap-2.5 border-b border-slate-200">
          <BookOpenCheck className="w-5 h-5 text-blue-600 shrink-0" aria-hidden="true" />
          <span className="text-base font-bold tracking-tight text-slate-900 whitespace-nowrap">
            Carbon 学术工坊
          </span>
        </div>

        <nav className="flex-1 p-3 space-y-1" aria-label="主导航">
          {navItems.map((item) => {
            const Icon = item.icon;
            const isSelected = activeTab === item.key;
            return (
              <button
                key={item.key}
                type="button"
                onClick={() => setActiveTab(item.key)}
                className={`w-full flex items-center justify-between px-3.5 py-2.5 text-sm font-medium rounded-lg transition-colors whitespace-nowrap ${
                  isSelected
                    ? 'bg-blue-50 text-blue-700 font-semibold'
                    : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900'
                }`}
              >
                <span className="flex items-center gap-3">
                  <Icon className="w-4 h-4 shrink-0" aria-hidden="true" />
                  <span>{item.label}</span>
                </span>
                {typeof item.count === 'number' && (
                  <span className="text-xs font-mono tabular-nums text-slate-500">
                    {item.count}
                  </span>
                )}
              </button>
            );
          })}
        </nav>

        {/* Recent Jobs Quick Switcher in Sidebar */}
        <div className="p-4 border-t border-slate-200 space-y-2.5">
          <div className="flex items-center justify-between text-xs text-slate-500">
            <span className="font-semibold text-slate-700">最近多端同步任务</span>
            <FolderArchive className="w-3.5 h-3.5 text-slate-400" aria-hidden="true" />
          </div>
          <div className="space-y-1 max-h-52 overflow-y-auto">
            {jobs.slice(0, 5).map((j) => {
              const label =
                j.plan?.documentTitle || j.rawUserPrompt.slice(0, 24) || '生成任务';
              const isCurrent = selectedJob?.id === j.id && activeTab === 'monitor';
              return (
                <button
                  key={j.id}
                  type="button"
                  onClick={() => {
                    setSelectedJobId(j.id);
                    setActiveTab('monitor');
                  }}
                  className={`w-full text-left px-2.5 py-1.5 rounded-md text-xs transition-colors truncate ${
                    isCurrent
                      ? 'bg-slate-100 font-semibold text-slate-900'
                      : 'text-slate-600 hover:bg-slate-50 hover:text-slate-900'
                  }`}
                >
                  {label}
                </button>
              );
            })}
          </div>
        </div>
      </aside>

      {/* Mobile Drawer Navigation */}
      {mobileMenuOpen && (
        <div className="fixed inset-0 z-40 lg:hidden flex no-print">
          <div
            className="fixed inset-0 bg-slate-950/40"
            onClick={() => setMobileMenuOpen(false)}
          />
          <aside className="relative z-10 w-64 max-w-[80vw] bg-white border-r border-slate-200 flex flex-col">
            <div className="h-16 px-4 flex items-center justify-between border-b border-slate-200">
              <span className="text-base font-bold text-slate-900">Carbon 学术工坊</span>
              <button
                type="button"
                onClick={() => setMobileMenuOpen(false)}
                aria-label="关闭导航菜单"
                className="p-1.5 text-slate-500 hover:text-slate-900 rounded-lg"
              >
                <X className="w-5 h-5" aria-hidden="true" />
              </button>
            </div>
            <nav className="p-3 space-y-1">
              {navItems.map((item) => {
                const Icon = item.icon;
                const isSelected = activeTab === item.key;
                return (
                  <button
                    key={item.key}
                    type="button"
                    onClick={() => {
                      setActiveTab(item.key);
                      setMobileMenuOpen(false);
                    }}
                    className={`w-full flex items-center justify-between px-3.5 py-2.5 text-sm font-medium rounded-lg ${
                      isSelected
                        ? 'bg-blue-50 text-blue-700 font-semibold'
                        : 'text-slate-600 hover:bg-slate-100'
                    }`}
                  >
                    <span className="flex items-center gap-3">
                      <Icon className="w-4 h-4 shrink-0" aria-hidden="true" />
                      <span>{item.label}</span>
                    </span>
                    {typeof item.count === 'number' && (
                      <span className="text-xs font-mono tabular-nums">{item.count}</span>
                    )}
                  </button>
                );
              })}
            </nav>
          </aside>
        </div>
      )}

      {/* Main Content Area */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Contextual SaaS Top Header (1-Row Contract) */}
        <header className="h-16 px-4 sm:px-8 bg-white border-b border-slate-200 flex items-center justify-between gap-4 shrink-0 no-print">
          <div className="flex items-center gap-3 min-w-0">
            <button
              type="button"
              onClick={() => setMobileMenuOpen(true)}
              aria-label="打开侧边导航"
              className="lg:hidden p-2 -ml-2 text-slate-600 hover:text-slate-900 rounded-lg"
            >
              <Menu className="w-5 h-5" aria-hidden="true" />
            </button>
            <div className="flex items-center gap-2 text-sm text-slate-500 truncate">
              <span className="hidden sm:inline font-medium text-slate-700 whitespace-nowrap">
                Carbon 学术工坊
              </span>
              <span className="hidden sm:inline" aria-hidden="true">
                /
              </span>
              <span className="font-semibold text-slate-900 truncate">
                {currentBreadcrumbLabel}
              </span>
            </div>
          </div>

          <GoogleSignInButton
            user={user}
            hasDriveToken={Boolean(driveToken)}
            isSigningIn={isSigningIn}
            onSignIn={handleGoogleSignIn}
            onSignOut={handleGoogleSignOut}
          />
        </header>

        {/* Optional Notification Banner */}
        {bannerNotice && (
          <div
            role="status"
            className={`px-4 sm:px-8 py-2.5 text-xs flex items-center justify-between gap-4 border-b no-print ${
              bannerNotice.tone === 'error'
                ? 'bg-red-50 border-red-200 text-red-700'
                : bannerNotice.tone === 'success'
                  ? 'bg-emerald-50 border-emerald-200 text-emerald-800'
                  : 'bg-slate-100 border-slate-200 text-slate-700'
            }`}
          >
            <span>{bannerNotice.text}</span>
            <button
              type="button"
              onClick={() => setBannerNotice(null)}
              aria-label="关闭通知提示"
              className="p-0.5 hover:opacity-75 shrink-0"
            >
              <X className="w-3.5 h-3.5" aria-hidden="true" />
            </button>
          </div>
        )}

        {/* Main Viewport */}
        <main ref={mainViewportRef} className="flex-1 p-4 sm:p-8 overflow-y-auto">
          {activeTab === 'composer' && (
            <ComposerPanel
              mode={mode}
              onModeChange={setMode}
              depth={depth}
              onDepthChange={setDepth}
              volumeSplitMode={volumeSplitMode}
              onVolumeSplitModeChange={setVolumeSplitMode}
              pageOrientation={pageOrientation}
              onPageOrientationChange={setPageOrientation}
              colorTheme={colorTheme}
              onColorThemeChange={setColorTheme}
              autoGenerateFigures={autoGenerateFigures}
              onAutoGenerateFiguresChange={setAutoGenerateFigures}
              prompt={prompt}
              onPromptChange={(val) => {
                setPrompt(val);
                if (validationError) setValidationError(null);
              }}
              attachments={attachments}
              onAddAttachments={handleAddAttachments}
              onIngestScannedAttachments={handleIngestScannedAttachments}
              onScannedLinksChange={setComposerScannedLinks}
              onRemoveAttachment={handleRemoveAttachment}
              uploadProgress={composerUploadProgress}
              availableHistoricalJobs={jobs.filter((j) => j.compiledMarkdown.trim().length > 0)}
              sourceContextJobIds={sourceContextJobIds}
              onToggleSourceContextJobId={handleToggleSourceContextJobId}
              onClearSourceContextJobs={handleClearSourceContextJobs}
              enableHistoricalMemory={enableHistoricalMemory}
              onEnableHistoricalMemoryChange={setEnableHistoricalMemory}
              driveToken={driveToken}
              autoArchiveDrive={autoArchiveDrive}
              onAutoArchiveDriveChange={setAutoArchiveDrive}
              customRootFolder={customRootFolder}
              onCustomRootFolderChange={setCustomRootFolder}
              hasDriveToken={Boolean(driveToken)}
              accountProfile={accountProfile}
              pricingConfig={pricingConfig}
              isSigningIn={isSigningIn}
              onRequestGoogleSignIn={() => {
                void handleGoogleSignIn();
              }}
              onOpenBillingTab={() => setActiveTab('billing_admin')}
              onVoiceError={(msg) => setBannerNotice({ tone: 'error', text: msg })}
              isParsingFiles={isParsingFiles}
              isRunningPipeline={isRunningPipeline}
              validationError={validationError}
              onSubmitPipeline={handleSubmitPipeline}
            />
          )}

          {activeTab === 'monitor' && (
            <PipelineMonitor
              job={selectedJob}
              allJobs={jobs}
              driveToken={driveToken}
              isCompilingPdfJobId={isCompilingPdfJobId}
              compilingVolumeKey={compilingVolumeKey}
              pdfCompileProgress={pdfCompileProgress}
              isUploadingDriveJobId={isUploadingDriveJobId}
              isResumingJobId={isResumingJobId}
              isSubmittingSupplement={isSubmittingSupplement}
              isExpandingJob={isExpandingJob}
              hasCachedPdf={Boolean(selectedJob && pdfCacheRef.current.has(selectedJob.id))}
              hasDriveToken={Boolean(driveToken)}
              onResumeJob={handleResumeJob}
              onSubmitSupplement={handleSupplementJob}
              onExpandCompletedJob={handleExpandCompletedJob}
              onLoadIntoComposerWithMemory={handleLoadIntoComposerWithMemory}
              onSelectJob={(jobId) => setSelectedJobId(jobId)}
              onDownloadPdf={handleDownloadPdf}
              onDownloadVolumePdf={handleDownloadVolumePdf}
              onDownloadAllVolumes={handleDownloadAllVolumes}
              onSyncToDrive={(job) => handleSyncJobToDrive(job)}
              onCancelRunningJob={handleCancelRunningJob}
              onGoToComposer={() => setActiveTab('composer')}
            />
          )}

          {activeTab === 'history' && (
            <HistoryPanel
              jobs={jobs}
              isCompilingPdfJobId={isCompilingPdfJobId}
              isUploadingDriveJobId={isUploadingDriveJobId}
              isResumingJobId={isResumingJobId}
              isSyncingFromDrive={isSyncingFromDrive}
              hasDriveToken={Boolean(driveToken)}
              onSelectJob={(jobId) => {
                setSelectedJobId(jobId);
                setActiveTab('monitor');
              }}
              onStartExpandFromHistory={(targetJob) => {
                setSelectedJobId(targetJob.id);
                setActiveTab('monitor');
                window.requestAnimationFrame(() => {
                  const el = document.getElementById('post-completion-expand-input');
                  if (el) {
                    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
                    el.focus();
                  }
                });
              }}
              onResumeJob={handleResumeJob}
              onSyncFromDrive={handleSyncFromDrive}
              onDownloadPdf={handleDownloadPdf}
              onSyncToDrive={(job) => handleSyncJobToDrive(job)}
              onRequestDeleteJob={(job) => setJobPendingDelete(job)}
              onGoToComposer={() => setActiveTab('composer')}
            />
          )}

          {activeTab === 'billing_admin' && (
            <BillingAndCloudPanel
              profile={accountProfile}
              pricing={pricingConfig}
              isSigningIn={isSigningIn}
              onRequestSignIn={handleGoogleSignIn}
              onTopUpWallet={handleTopUpWallet}
              onSubscribeMonthly={handleSubscribeMonthly}
              onSaveCloudConfig={handleSaveCloudConfig}
              onFetchAdminOverview={handleFetchAdminOverview}
              onAdminUpdatePricing={handleAdminUpdatePricing}
              onAdminGrantUser={handleAdminGrantUser}
            />
          )}
        </main>
      </div>

      {/* Explicit Confirmation Modal for Destructive Deletions */}
      <ConfirmDialog
        open={Boolean(jobPendingDelete)}
        title="确认删除该生成记录？"
        description={
          jobPendingDelete
            ? `即将从任务列表中移除《${
                jobPendingDelete.plan?.documentTitle ||
                jobPendingDelete.rawUserPrompt.slice(0, 30)
              }》。此操作不可撤销。`
            : ''
        }
        canAlsoDeleteDriveFile={Boolean(
          jobPendingDelete?.driveArchive.status === 'archived' &&
            jobPendingDelete?.driveArchive.fileId &&
            driveToken
        )}
        driveFolderPath={jobPendingDelete?.driveArchive.folderPath}
        confirmLabel="确认删除"
        onCancel={() => setJobPendingDelete(null)}
        onConfirm={handleConfirmDeleteJob}
      />
    </div>
  );
}
