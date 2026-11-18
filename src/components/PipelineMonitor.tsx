import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertCircle,
  ArrowLeft,
  BookCopy,
  Check,
  CheckCircle2,
  CloudUpload,
  Code2,
  Copy,
  Cpu,
  Download,
  ExternalLink,
  FileCheck2,
  FileText,
  FolderTree,
  GitBranchPlus,
  GitMerge,
  Image as ImageIcon,
  Layers,
  Loader2,
  Play,
  Printer,
  RefreshCw,
  RotateCcw,
  ShieldCheck,
  Square,
} from 'lucide-react';
import type {
  ColorPaletteTheme,
  DepthPreset,
  DocMode,
  GeneratedVolumeArtifact,
  PipelineJob,
  PostCompletionExpansionMode,
  ResumeStrategy,
  ScannedLinkResult,
  UploadedAttachment,
} from '../types';
import { compileAcademicPdfBlob } from '../services/pdfGenerator';
import { renderAcademicMarkdown } from '../utils/markdownMathRenderer';
import {
  getToolModelEntry,
  resolveColorPaletteSpec,
} from '../utils/modelRegistryAndRouter';
import { detectResolvedPageOrientation } from '../utils/pdfServerHelpers';
import {
  buildDriveArchivePath,
  calculateJobProgress,
  isJobResumable,
  splitMarkdownIntoSemanticBlocks,
} from '../utils/pipelineLogic';
import { LiveSupplementBar } from './LiveSupplementBar';
import { PostCompletionExpansionCard } from './PostCompletionExpansionCard';

const PREVIEW_COVER_THEME_CLASSES: Record<
  ColorPaletteTheme,
  { box: string; meta: string; title: string }
> = {
  academic_blue: {
    box: 'bg-blue-50/70 border-blue-200',
    meta: 'text-blue-800',
    title: 'text-slate-900',
  },
  emerald_science: {
    box: 'bg-emerald-50/70 border-emerald-200',
    meta: 'text-emerald-800',
    title: 'text-emerald-950',
  },
  amber_olympiad: {
    box: 'bg-amber-50/80 border-amber-200',
    meta: 'text-amber-800',
    title: 'text-amber-950',
  },
  burgundy_editorial: {
    box: 'bg-rose-50/70 border-rose-200',
    meta: 'text-rose-800',
    title: 'text-rose-950',
  },
};

type ArtifactCanvasTab = 'canvas' | 'native_pdf' | 'markdown';
type LeftRailTab = 'modules' | 'specs';

interface PipelineMonitorProps {
  job: PipelineJob | null;
  allJobs?: PipelineJob[];
  driveToken?: string | null;
  isCompilingPdfJobId: string | null;
  compilingVolumeKey?: string | null;
  pdfCompileProgress: { current: number; total: number } | null;
  isUploadingDriveJobId: string | null;
  isResumingJobId: string | null;
  isSubmittingSupplement: boolean;
  isExpandingJob?: boolean;
  hasCachedPdf: boolean;
  hasDriveToken: boolean;
  onResumeJob: (
    job: PipelineJob,
    strategy: ResumeStrategy,
    targetBatchIndex?: number
  ) => Promise<void>;
  onSubmitSupplement: (params: {
    jobId: string;
    text: string;
    source: 'text' | 'voice';
    attachments: UploadedAttachment[];
  }) => Promise<void>;
  onExpandCompletedJob?: (params: {
    sourceJob: PipelineJob;
    expansionMode: PostCompletionExpansionMode;
    expansionPrompt: string;
    targetDocMode: DocMode;
    depth: DepthPreset;
    source: 'text' | 'voice';
    attachments: UploadedAttachment[];
    scannedLinks: ScannedLinkResult[];
  }) => Promise<void>;
  onLoadIntoComposerWithMemory?: (sourceJob: PipelineJob, suggestedMode: DocMode) => void;
  onSelectJob?: (jobId: string) => void;
  onDownloadPdf: (job: PipelineJob) => Promise<void>;
  onDownloadVolumePdf?: (
    job: PipelineJob,
    volume: GeneratedVolumeArtifact
  ) => Promise<void>;
  onDownloadAllVolumes?: (job: PipelineJob) => Promise<void>;
  onSyncToDrive: (job: PipelineJob) => Promise<void>;
  onCancelRunningJob: () => void;
  onGoToComposer: () => void;
}

export const PipelineMonitor: React.FC<PipelineMonitorProps> = ({
  job,
  allJobs = [],
  driveToken,
  isCompilingPdfJobId,
  compilingVolumeKey = null,
  pdfCompileProgress,
  isUploadingDriveJobId,
  isResumingJobId,
  isSubmittingSupplement,
  isExpandingJob = false,
  hasCachedPdf,
  hasDriveToken,
  onResumeJob,
  onSubmitSupplement,
  onExpandCompletedJob,
  onLoadIntoComposerWithMemory,
  onSelectJob,
  onDownloadPdf,
  onDownloadVolumePdf,
  onDownloadAllVolumes,
  onSyncToDrive,
  onCancelRunningJob,
  onGoToComposer,
}) => {
  const [artifactTab, setArtifactTab] = useState<ArtifactCanvasTab>('canvas');
  const [leftRailTab, setLeftRailTab] = useState<LeftRailTab>('modules');
  const [copiedSource, setCopiedSource] = useState(false);
  const [pdfRefreshNonce, setPdfRefreshNonce] = useState(0);
  const [localSeedPdfUrl, setLocalSeedPdfUrl] = useState<string | null>(null);
  const [isGeneratingSeedPreview, setIsGeneratingSeedPreview] = useState(false);

  const [volumeSelection, setVolumeSelection] = useState<{
    jobId: string;
    volumeId: string;
  } | null>(null);

  const multiVolumes = useMemo(() => {
    if (!job || !job.outputVolumes || job.outputVolumes.length <= 1) return null;
    return job.outputVolumes;
  }, [job]);

  const activeVolumeId = useMemo(() => {
    if (!job || !multiVolumes) return 'all';
    if (
      volumeSelection &&
      volumeSelection.jobId === job.id &&
      (volumeSelection.volumeId === 'all' ||
        multiVolumes.some((v) => v.volumeId === volumeSelection.volumeId))
    ) {
      return volumeSelection.volumeId;
    }
    const firstWithContent =
      multiVolumes.find((v) => v.compiledMarkdown.trim().length > 0) || multiVolumes[0];
    return firstWithContent.volumeId;
  }, [job, multiVolumes, volumeSelection]);

  const selectedVolumeArtifact = useMemo(() => {
    if (!multiVolumes || activeVolumeId === 'all') return null;
    return multiVolumes.find((v) => v.volumeId === activeVolumeId) || null;
  }, [multiVolumes, activeVolumeId]);

  const progressInfo = useMemo(() => {
    if (!job) {
      return {
        percent: 0,
        completedBatches: 0,
        totalBatches: 0,
        activeBatchIndex: -1,
        totalContinuations: 0,
      };
    }
    return calculateJobProgress({ stage: job.stage, batches: job.batches });
  }, [job]);

  const activeColorTheme: ColorPaletteTheme =
    job?.colorTheme || job?.plan?.colorTheme || 'academic_blue';
  const activeColorPalette = useMemo(
    () => resolveColorPaletteSpec(activeColorTheme),
    [activeColorTheme]
  );

  const resolvedOrientation = useMemo(() => {
    if (!job) return 'portrait' as const;
    return detectResolvedPageOrientation({
      explicitOrientation: job.pageOrientation,
      planOrientation: job.plan?.pageOrientation,
      rawPrompt: job.rawUserPrompt,
      directivesTexts: (job.supplementalDirectives || []).map((d) => d.text),
    });
  }, [job]);

  const [expandedFullCanvasJobId, setExpandedFullCanvasJobId] = useState<string | null>(null);
  const LIVE_CANVAS_FAST_CHAR_BUDGET = 48_000;

  const activePreviewMarkdown = selectedVolumeArtifact
    ? selectedVolumeArtifact.compiledMarkdown
    : job?.compiledMarkdown || '';

  const currentSliceKey = `${job?.id || ''}:${selectedVolumeArtifact?.volumeId || 'all'}`;
  const isCanvasFullExpanded = expandedFullCanvasJobId === currentSliceKey;

  const { displayedCanvasMarkdown, isCanvasWindowed } = useMemo(() => {
    if (
      !activePreviewMarkdown ||
      isCanvasFullExpanded ||
      activePreviewMarkdown.length <= LIVE_CANVAS_FAST_CHAR_BUDGET
    ) {
      return { displayedCanvasMarkdown: activePreviewMarkdown, isCanvasWindowed: false };
    }
    const cutIdx = activePreviewMarkdown.indexOf('\n\n', LIVE_CANVAS_FAST_CHAR_BUDGET);
    const sliceEnd =
      cutIdx !== -1 && cutIdx < LIVE_CANVAS_FAST_CHAR_BUDGET + 4000
        ? cutIdx
        : LIVE_CANVAS_FAST_CHAR_BUDGET;
    return {
      displayedCanvasMarkdown: activePreviewMarkdown.slice(0, sliceEnd),
      isCanvasWindowed: true,
    };
  }, [activePreviewMarkdown, isCanvasFullExpanded]);

  const renderedHtml = useMemo(() => {
    if (!displayedCanvasMarkdown) return '';
    return renderAcademicMarkdown(displayedCanvasMarkdown, activeColorTheme);
  }, [displayedCanvasMarkdown, activeColorTheme]);

  // Determine whether this job is served by the backend `/api/jobs/:id/.../pdf?inline=1` endpoint
  const isServerBackedJob = Boolean(
    job &&
      !job.id.startsWith('seed-') &&
      (job.executionHost === 'server_cloud' ||
        job.serverPdfReady ||
        selectedVolumeArtifact?.serverPdfReady)
  );

  const inlineServerPdfUrl = useMemo(() => {
    if (!job || !isServerBackedJob || !activePreviewMarkdown.trim()) return null;
    if (selectedVolumeArtifact) {
      return `/api/jobs/${encodeURIComponent(job.id)}/volumes/${encodeURIComponent(
        selectedVolumeArtifact.volumeId
      )}/pdf?inline=1&r=${pdfRefreshNonce}`;
    }
    if (multiVolumes && multiVolumes.length > 0) {
      const firstReady =
        multiVolumes.find((v) => v.compiledMarkdown.trim().length > 0) || multiVolumes[0];
      return `/api/jobs/${encodeURIComponent(job.id)}/volumes/${encodeURIComponent(
        firstReady.volumeId
      )}/pdf?inline=1&r=${pdfRefreshNonce}`;
    }
    return `/api/jobs/${encodeURIComponent(job.id)}/pdf?inline=1&r=${pdfRefreshNonce}`;
  }, [job, isServerBackedJob, activePreviewMarkdown, selectedVolumeArtifact, multiVolumes, pdfRefreshNonce]);

  // Client-side native PDF blob preview fallback for local-only seed demo jobs (`seed-*`)
  const buildSeedPdfPreview = useCallback(async () => {
    if (!job || isServerBackedJob || !activePreviewMarkdown.trim()) return;
    setIsGeneratingSeedPreview(true);
    try {
      const compiled = await compileAcademicPdfBlob(
        job,
        undefined,
        selectedVolumeArtifact || undefined
      );
      const nextUrl = URL.createObjectURL(compiled.blob);
      setLocalSeedPdfUrl((prev) => {
        if (prev) URL.revokeObjectURL(prev);
        return nextUrl;
      });
    } catch {
      // Fallback gracefully if canvas fails
    } finally {
      setIsGeneratingSeedPreview(false);
    }
  }, [job, isServerBackedJob, activePreviewMarkdown, selectedVolumeArtifact]);

  const supportsInlineBrowserPdf =
    typeof navigator !== 'undefined' && navigator.pdfViewerEnabled === true;

  const [pdfRenderSubMode, setPdfRenderSubMode] = useState<'browser_plugin' | 'paginated_sheets'>(
    () => (supportsInlineBrowserPdf ? 'browser_plugin' : 'paginated_sheets')
  );

  const paginatedPdfSheetsHtml = useMemo(() => {
    if (artifactTab !== 'native_pdf' || !displayedCanvasMarkdown.trim()) return [];
    const blocks = splitMarkdownIntoSemanticBlocks(displayedCanvasMarkdown);
    const charsPerSheet = resolvedOrientation === 'landscape' ? 1150 : 1750;
    const sheetsMd: string[] = [];
    let currentBuf = '';
    for (const blk of blocks) {
      if (currentBuf.length > 0 && currentBuf.length + blk.length > charsPerSheet) {
        sheetsMd.push(currentBuf.trim());
        currentBuf = blk;
      } else {
        currentBuf = currentBuf ? `${currentBuf}\n\n${blk}` : blk;
      }
    }
    if (currentBuf.trim()) {
      sheetsMd.push(currentBuf.trim());
    }
    return sheetsMd.slice(0, 28).map((md) => renderAcademicMarkdown(md, activeColorTheme));
  }, [artifactTab, displayedCanvasMarkdown, resolvedOrientation, activeColorTheme]);

  useEffect(() => {
    setLocalSeedPdfUrl((prev) => {
      if (prev) URL.revokeObjectURL(prev);
      return null;
    });
  }, [job?.id, selectedVolumeArtifact?.volumeId]);

  useEffect(() => {
    if (
      artifactTab === 'native_pdf' &&
      pdfRenderSubMode === 'browser_plugin' &&
      supportsInlineBrowserPdf &&
      job &&
      !isServerBackedJob &&
      !localSeedPdfUrl &&
      !isGeneratingSeedPreview
    ) {
      void buildSeedPdfPreview();
    }
  }, [
    artifactTab,
    pdfRenderSubMode,
    supportsInlineBrowserPdf,
    job,
    isServerBackedJob,
    localSeedPdfUrl,
    isGeneratingSeedPreview,
    buildSeedPdfPreview,
  ]);

  const handleCopyMarkdown = async () => {
    if (!activePreviewMarkdown) return;
    try {
      await navigator.clipboard.writeText(activePreviewMarkdown);
      setCopiedSource(true);
      window.setTimeout(() => setCopiedSource(false), 1800);
    } catch {
      // Ignore clipboard permission restrictions
    }
  };

  if (!job) {
    return (
      <div className="max-w-2xl mx-auto py-16 text-center space-y-4 bg-white border border-slate-200 rounded-xl p-8">
        <FileCheck2 className="w-10 h-10 text-slate-400 mx-auto" aria-hidden="true" />
        <h2 className="text-lg font-semibold text-slate-900">当前暂无选中的文档工作流</h2>
        <p className="text-sm text-slate-500">
          前往新建工作台输入讲义或练习题册需求，系统将在此分屏实时呈现多模型推理进度、排版画布与原生矢量 PDF 预览。
        </p>
        <button
          type="button"
          onClick={onGoToComposer}
          className="inline-flex items-center gap-2 px-4 py-2 text-xs font-semibold text-white bg-blue-600 rounded-lg hover:bg-blue-700 transition-colors whitespace-nowrap shrink-0"
        >
          <ArrowLeft className="w-3.5 h-3.5" aria-hidden="true" />
          <span>前往新建生成任务</span>
        </button>
      </div>
    );
  }

  const isRunning =
    job.stage === 'planning' ||
    job.stage === 'executing' ||
    job.stage === 'compiling_pdf' ||
    job.stage === 'uploading_drive';

  const isThisCompiling = isCompilingPdfJobId === job.id;
  const isThisUploading =
    isUploadingDriveJobId === job.id || job.driveArchive.status === 'uploading';
  const isThisResuming = isResumingJobId === job.id;
  const canResumeJob = !isRunning && isJobResumable(job);

  const parentJob = job.parentJobId
    ? allJobs.find((candidate) => candidate.id === job.parentJobId) || null
    : null;

  const interruptedBatch = job.batches.find(
    (b) => b.status !== 'completed' && b.markdownContent.trim().length > 0
  );
  const preservedPartialChars = interruptedBatch?.markdownContent.trim().length || 0;

  const archivePathObj = buildDriveArchivePath({
    rootFolder: job.plan?.archiveRootFolder || job.customRootFolder,
    subjectCategory: job.plan?.subjectCategory,
    mode: job.mode,
  });

  const stageSteps = [
    {
      key: 'planning',
      label: '01. Carbon 总纲与专精模型路由',
      done: Boolean(job.plan),
      active: job.stage === 'planning',
    },
    {
      key: 'executing',
      label: '02. 多模型分模块精写与配图填色',
      done:
        job.stage === 'compiling_pdf' ||
        job.stage === 'uploading_drive' ||
        job.stage === 'completed',
      active: job.stage === 'executing',
    },
    {
      key: 'compiling_pdf',
      label: '03. 终稿无缝拼接与矢量 PDF 编译',
      done:
        job.stage === 'uploading_drive' ||
        job.stage === 'completed' ||
        Boolean(job.serverPdfReady),
      active: job.stage === 'compiling_pdf' || isThisCompiling,
    },
    {
      key: 'uploading_drive',
      label: '04. 个人 Google Cloud 云盘归档',
      done: job.driveArchive.status === 'archived',
      active: job.stage === 'uploading_drive' || isThisUploading,
    },
  ];

  const coverThemeClasses = PREVIEW_COVER_THEME_CLASSES[activeColorTheme];
  const effectivePdfPreviewUrl = inlineServerPdfUrl || localSeedPdfUrl;

  return (
    <div className="max-w-[1440px] mx-auto grid grid-cols-1 xl:grid-cols-[368px_minmax(0,1fr)] gap-5 items-start">
      {/* =====================================================================
          LEFT PANE: Autonomous Thinking, Unattended Guard, Volumes & Conversational Follow-up
         ===================================================================== */}
      <div className="space-y-4 xl:sticky xl:top-2 no-print">
        {/* Card 1: Autonomous Pipeline Status & 4-Stage Stepper */}
        <section
          aria-label="自动化生成进度与守护状态"
          className="bg-white border border-slate-200 rounded-xl p-4 space-y-3.5"
        >
          <div className="space-y-1.5">
            {/* Clean Unboxed Metadata */}
            <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-xs text-slate-500 font-mono tabular-nums">
              <span>{job.plan?.courseCode || 'CARBON'}</span>
              <span aria-hidden="true">·</span>
              <span className="font-sans">{job.plan?.subjectCategory || '识别学科中'}</span>
              <span aria-hidden="true">·</span>
              <span>{job.charCount.toLocaleString()} 字</span>
              <span aria-hidden="true">·</span>
              <span>{job.formulaCount} 处公式</span>
              <span aria-hidden="true">·</span>
              <span>~{job.estimatedPages} 页</span>
            </div>

            <h1 className="text-base sm:text-lg font-bold text-slate-900 leading-snug">
              {job.plan?.documentTitle || '正在规划学术文档结构与多模型分工...'}
            </h1>

            {parentJob && onSelectJob && (
              <button
                type="button"
                onClick={() => onSelectJob(parentJob.id)}
                className="inline-flex items-center gap-1 text-xs text-blue-700 hover:underline"
              >
                <GitBranchPlus className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
                <span className="truncate max-w-[300px]">
                  派生自《{parentJob.plan?.documentTitle || parentJob.rawUserPrompt}》
                </span>
              </button>
            )}
          </div>

          {/* Unattended Zero-Pause Autonomous Guard Banner */}
          <div className="flex items-start justify-between gap-2 px-3 py-2 bg-slate-50 border border-slate-200 rounded-lg text-xs text-slate-700">
            <div className="flex items-start gap-2 min-w-0">
              <ShieldCheck className="w-4 h-4 text-emerald-600 mt-0.5 shrink-0" aria-hidden="true" />
              <div className="leading-relaxed">
                <span className="font-semibold text-slate-900">全自动无人值守引擎已开启</span>
                <span className="text-slate-500">
                  {' '}
                  · 网络波动、流超时或局部公式异常均在云端自动切模续跑，无需手动点击继续
                </span>
                {(job.autoRecoveryCount || 0) > 0 && (
                  <span className="font-mono tabular-nums text-emerald-700 font-semibold ml-1">
                    (已自动无感自愈 {job.autoRecoveryCount} 次)
                  </span>
                )}
              </div>
            </div>
          </div>

          {/* Progress Bar */}
          <div className="space-y-2">
            <div className="flex items-center justify-between gap-2 text-xs">
              <span className="font-medium text-slate-700 truncate">
                {job.stage === 'planning' && 'Carbon 正在流式构建总纲与分册路由...'}
                {job.stage === 'executing' &&
                  `正在精写第 ${Math.max(1, progressInfo.activeBatchIndex + 1)}/${progressInfo.totalBatches} 模块...`}
                {job.stage === 'compiling_pdf' && '正在拼接终稿并编译原生矢量 PDF...'}
                {job.stage === 'uploading_drive' && '正在同步归档至您的个人 Google Cloud...'}
                {job.stage === 'completed' &&
                  `全部 ${progressInfo.totalBatches} 个模块精编并合成完毕`}
                {job.stage === 'cancelled' && '已手动暂停（全部已完成断点已锁定）'}
                {job.stage === 'error' && '后台自愈引擎正在检测或等待恢复断点'}
              </span>
              <span className="font-mono font-semibold text-slate-900 tabular-nums shrink-0">
                {progressInfo.percent}%
              </span>
            </div>

            <div className="w-full h-1.5 bg-slate-100 rounded-full overflow-hidden">
              <div
                className={`h-full transition-transform duration-200 origin-left ${
                  job.stage === 'error'
                    ? 'bg-red-600'
                    : job.stage === 'completed'
                      ? 'bg-emerald-600'
                      : 'bg-blue-600'
                }`}
                style={{
                  width: '100%',
                  transform: `scaleX(${Math.max(0.02, progressInfo.percent / 100)})`,
                }}
              />
            </div>

            {/* Compact 4-Stage Stepper */}
            <div className="space-y-1.5 pt-1">
              {stageSteps.map((s) => (
                <div key={s.key} className="flex items-center gap-2 text-xs">
                  {s.active ? (
                    <Loader2
                      className="w-3.5 h-3.5 animate-spin text-blue-600 shrink-0"
                      aria-hidden="true"
                    />
                  ) : s.done ? (
                    <CheckCircle2
                      className="w-3.5 h-3.5 text-emerald-600 shrink-0"
                      aria-hidden="true"
                    />
                  ) : (
                    <span
                      className="w-3.5 h-3.5 rounded-full border border-slate-300 shrink-0"
                      aria-hidden="true"
                    />
                  )}
                  <span
                    className={`truncate ${
                      s.active
                        ? 'font-semibold text-blue-700'
                        : s.done
                          ? 'text-slate-800 font-medium'
                          : 'text-slate-500'
                    }`}
                  >
                    {s.label}
                  </span>
                </div>
              ))}
            </div>
          </div>

          {/* Cloud Path & Pause / Resume Controls */}
          <div className="pt-2 border-t border-slate-100 flex flex-wrap items-center justify-between gap-2 text-xs text-slate-500">
            <span className="inline-flex items-center gap-1.5 truncate max-w-[230px]">
              <FolderTree className="w-3.5 h-3.5 text-slate-400 shrink-0" aria-hidden="true" />
              <span className="font-mono truncate">
                {job.driveArchive.folderPath || archivePathObj.fullPath}
              </span>
            </span>

            {isRunning && (
              <button
                type="button"
                onClick={onCancelRunningJob}
                className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium text-red-700 bg-red-50 border border-red-200 rounded-md hover:bg-red-100 transition-colors whitespace-nowrap shrink-0"
              >
                <Square className="w-3 h-3 fill-current" aria-hidden="true" />
                <span>手动暂停</span>
              </button>
            )}
          </div>

          {canResumeJob && (
            <div
              role="alert"
              className={`p-3 rounded-lg border space-y-2 ${
                job.stage === 'error'
                  ? 'bg-red-50/70 border-red-200 text-red-900'
                  : 'bg-amber-50/70 border-amber-200 text-amber-950'
              }`}
            >
              <div className="flex items-center gap-1.5 text-xs font-semibold">
                <AlertCircle className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
                <span>
                  {job.stage === 'cancelled'
                    ? '任务已手动暂停 · 断点完整保留'
                    : '任务处于断点保护状态（守护进程亦会自动接续）'}
                </span>
              </div>
              {(job.errorMessage || job.driveArchive.error) && (
                <p className="text-xs opacity-90 leading-relaxed">
                  {job.errorMessage || job.driveArchive.error}
                </p>
              )}
              <p className="text-[11px] font-mono tabular-nums opacity-80">
                已完成 {progressInfo.completedBatches}/{progressInfo.totalBatches || 1} 模块
                {preservedPartialChars > 0
                  ? ` · 保留半截正文 ${preservedPartialChars.toLocaleString()} 字`
                  : ''}
              </p>
              <div className="flex flex-wrap items-center gap-2 pt-0.5">
                <button
                  type="button"
                  disabled={isThisResuming}
                  onClick={() => onResumeJob(job, 'continue')}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-white bg-blue-600 rounded-lg hover:bg-blue-700 disabled:opacity-60 transition-colors whitespace-nowrap shrink-0"
                >
                  {isThisResuming ? (
                    <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" />
                  ) : (
                    <Play className="w-3.5 h-3.5 fill-current" aria-hidden="true" />
                  )}
                  <span>从断点继续</span>
                </button>
                <button
                  type="button"
                  disabled={isThisResuming}
                  onClick={() => onResumeJob(job, 'retry_batch')}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-800 bg-white border border-slate-300 rounded-lg hover:bg-slate-50 disabled:opacity-60 transition-colors whitespace-nowrap shrink-0"
                >
                  <RotateCcw className="w-3.5 h-3.5" aria-hidden="true" />
                  <span>重跑当前模块</span>
                </button>
              </div>
            </div>
          )}
        </section>

        {/* Card 2: Multi-Volume Independent PDF Switcher */}
        {multiVolumes && (
          <section
            aria-label="多份独立分册切换与导出"
            className="bg-white border border-slate-200 rounded-xl divide-y divide-slate-100"
          >
            <div className="px-4 py-3 flex items-center justify-between gap-2">
              <div className="flex items-center gap-2 min-w-0">
                <BookCopy className="w-4 h-4 text-blue-600 shrink-0" aria-hidden="true" />
                <h2 className="text-xs font-semibold text-slate-900 truncate">
                  独立分册文件 ({multiVolumes.length} 份 PDF)
                </h2>
              </div>
              <div className="flex items-center gap-1.5 shrink-0">
                <button
                  type="button"
                  onClick={() => setVolumeSelection({ jobId: job.id, volumeId: 'all' })}
                  className={`px-2 py-1 text-[11px] font-semibold rounded border transition-colors whitespace-nowrap shrink-0 ${
                    activeVolumeId === 'all'
                      ? 'bg-slate-900 text-white border-slate-900'
                      : 'bg-white text-slate-600 border-slate-200 hover:bg-slate-50'
                  }`}
                >
                  全册合览
                </button>
                {onDownloadAllVolumes && (
                  <button
                    type="button"
                    disabled={
                      isThisCompiling ||
                      !multiVolumes.some((v) => v.compiledMarkdown.trim().length > 0)
                    }
                    onClick={() => onDownloadAllVolumes(job)}
                    className="px-2 py-1 text-[11px] font-semibold text-blue-700 bg-blue-50 border border-blue-200 rounded hover:bg-blue-100 disabled:opacity-50 transition-colors whitespace-nowrap shrink-0"
                  >
                    全部下载
                  </button>
                )}
              </div>
            </div>

            <div className="max-h-64 overflow-y-auto divide-y divide-slate-100">
              {multiVolumes.map((vol) => {
                const isSelected = activeVolumeId === vol.volumeId;
                const isVolCompiling =
                  compilingVolumeKey === `${job.id}:${vol.volumeId}` || isThisCompiling;
                const hasContent = vol.compiledMarkdown.trim().length > 0;

                return (
                  <div
                    key={vol.volumeId}
                    className={`px-4 py-2.5 flex items-center justify-between gap-2 transition-colors ${
                      isSelected ? 'bg-blue-50/50' : 'hover:bg-slate-50/70'
                    }`}
                  >
                    <button
                      type="button"
                      onClick={() =>
                        setVolumeSelection({ jobId: job.id, volumeId: vol.volumeId })
                      }
                      className="text-left min-w-0 flex-1 space-y-0.5"
                    >
                      <div className="flex items-center gap-1.5 text-[11px] font-mono tabular-nums text-slate-500">
                        <span className="font-semibold text-blue-700">
                          分册 {vol.volumeIndex}/{multiVolumes.length}
                        </span>
                        <span aria-hidden="true">·</span>
                        <span>{vol.charCount.toLocaleString()} 字</span>
                        <span aria-hidden="true">·</span>
                        <span className="font-sans">
                          {vol.status === 'completed'
                            ? '已就绪'
                            : vol.status === 'generating'
                              ? '生成中'
                              : '待排队'}
                        </span>
                      </div>
                      <div className="text-xs font-semibold text-slate-900 truncate">
                        {vol.volumeTitle}
                      </div>
                    </button>

                    <div className="flex items-center gap-1 shrink-0">
                      {vol.driveWebViewLink && (
                        <a
                          href={vol.driveWebViewLink}
                          target="_blank"
                          rel="noopener noreferrer"
                          aria-label={`在云盘打开《${vol.volumeTitle}》`}
                          className="p-1.5 text-emerald-700 hover:bg-emerald-50 rounded transition-colors"
                        >
                          <ExternalLink className="w-3.5 h-3.5" aria-hidden="true" />
                        </a>
                      )}
                      {onDownloadVolumePdf && (
                        <button
                          type="button"
                          disabled={!hasContent || isVolCompiling}
                          onClick={() => onDownloadVolumePdf(job, vol)}
                          aria-label={`下载《${vol.volumeTitle}》PDF`}
                          className="inline-flex items-center gap-1 px-2 py-1 text-[11px] font-semibold text-slate-800 bg-white border border-slate-200 rounded hover:bg-slate-100 disabled:opacity-50 transition-colors whitespace-nowrap shrink-0"
                        >
                          {isVolCompiling ? (
                            <Loader2 className="w-3 h-3 animate-spin text-blue-600" aria-hidden="true" />
                          ) : (
                            <Download className="w-3 h-3 text-blue-600" aria-hidden="true" />
                          )}
                          <span>PDF</span>
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </section>
        )}

        {/* Card 3: Specialist Modules Stream & Requirements / Model Telemetry */}
        <section
          aria-label="模块化协同流与需求总表"
          className="bg-white border border-slate-200 rounded-xl overflow-hidden"
        >
          <div
            className="px-3 py-2 bg-slate-50 border-b border-slate-200 flex items-center gap-1"
            role="tablist"
          >
            <button
              type="button"
              role="tab"
              aria-selected={leftRailTab === 'modules'}
              onClick={() => setLeftRailTab('modules')}
              className={`flex-1 inline-flex items-center justify-center gap-1.5 py-1.5 px-2.5 text-xs font-semibold rounded-md transition-colors whitespace-nowrap shrink-0 ${
                leftRailTab === 'modules'
                  ? 'bg-white text-slate-900 shadow-2xs'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              <Layers className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
              <span>精编模块流 ({job.batches.length})</span>
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={leftRailTab === 'specs'}
              onClick={() => setLeftRailTab('specs')}
              className={`flex-1 inline-flex items-center justify-center gap-1.5 py-1.5 px-2.5 text-xs font-semibold rounded-md transition-colors whitespace-nowrap shrink-0 ${
                leftRailTab === 'specs'
                  ? 'bg-white text-slate-900 shadow-2xs'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              <Cpu className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
              <span>需求与模型明细</span>
            </button>
          </div>

          {leftRailTab === 'modules' ? (
            <div className="max-h-80 overflow-y-auto divide-y divide-slate-100">
              {job.batches.length === 0 ? (
                <div className="p-6 text-center text-xs text-slate-500">
                  正在调用 Carbon 总纲编排器规划模块与专精模型分工...
                </div>
              ) : (
                job.batches.map((b, idx) => {
                  const spec = job.plan?.batches[idx];
                  const effectiveModelId =
                    b.modelUsed || b.assignedModelId || spec?.assignedModelId || 'gemini-4-carbon';
                  const modelEntry = getToolModelEntry(effectiveModelId);

                  return (
                    <div key={b.batchIndex} className="px-4 py-3 space-y-1.5">
                      <div className="flex items-start justify-between gap-2">
                        <div className="flex items-start gap-2 min-w-0">
                          {b.status === 'completed' ? (
                            <CheckCircle2
                              className="w-3.5 h-3.5 text-emerald-600 mt-0.5 shrink-0"
                              aria-hidden="true"
                            />
                          ) : b.status === 'running' || b.status === 'continuing' ? (
                            <Loader2
                              className="w-3.5 h-3.5 animate-spin text-blue-600 mt-0.5 shrink-0"
                              aria-hidden="true"
                            />
                          ) : b.status === 'error' ? (
                            <AlertCircle
                              className="w-3.5 h-3.5 text-red-600 mt-0.5 shrink-0"
                              aria-hidden="true"
                            />
                          ) : (
                            <span
                              className="w-3.5 h-3.5 rounded-full border border-slate-300 mt-0.5 shrink-0"
                              aria-hidden="true"
                            />
                          )}
                          <div className="min-w-0">
                            <div className="text-xs font-semibold text-slate-900 leading-snug">
                              {b.batchIndex}. {b.title}
                            </div>
                            <div className="text-[11px] text-slate-500 font-mono tabular-nums">
                              <span className="text-blue-700 font-semibold">
                                {modelEntry.codeName}
                              </span>
                              <span aria-hidden="true"> · </span>
                              <span>{b.markdownContent.length.toLocaleString()} 字</span>
                              {b.continuationCount > 0 && (
                                <>
                                  <span aria-hidden="true"> · </span>
                                  <span>续补 {b.continuationCount} 次</span>
                                </>
                              )}
                            </div>
                          </div>
                        </div>

                        {!isRunning && b.status !== 'completed' && (
                          <button
                            type="button"
                            disabled={isThisResuming}
                            onClick={() =>
                              onResumeJob(
                                job,
                                b.markdownContent.trim().length > 0 ? 'continue' : 'retry_batch',
                                idx
                              )
                            }
                            className="px-2 py-1 text-[11px] font-semibold text-blue-700 bg-blue-50 border border-blue-200 rounded hover:bg-blue-100 whitespace-nowrap shrink-0"
                          >
                            续跑
                          </button>
                        )}
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          ) : (
            <div className="p-4 max-h-80 overflow-y-auto space-y-3 text-xs">
              {job.consolidatedRequirements && (
                <div className="space-y-1.5">
                  <div className="flex items-center gap-1.5 font-semibold text-slate-900">
                    <GitMerge className="w-3.5 h-3.5 text-blue-600" aria-hidden="true" />
                    <span>整合执行总纲 (v{job.consolidatedRequirements.version})</span>
                  </div>
                  <div className="p-2.5 bg-slate-50 border border-slate-200 rounded-lg text-slate-700 whitespace-pre-line leading-relaxed">
                    {job.consolidatedRequirements.synthesizedMasterBrief}
                  </div>
                </div>
              )}

              {job.modelUsageBreakdown && job.modelUsageBreakdown.length > 0 && (
                <div className="space-y-1.5">
                  <div className="font-semibold text-slate-900">多模型实测调用统计</div>
                  <div className="divide-y divide-slate-100 border border-slate-200 rounded-lg">
                    {job.modelUsageBreakdown.map((stat) => {
                      const entry = getToolModelEntry(stat.modelId);
                      return (
                        <div
                          key={stat.modelId}
                          className="px-2.5 py-2 flex items-center justify-between gap-2"
                        >
                          <div className="min-w-0">
                            <span className="font-semibold text-slate-900">{entry.codeName}</span>
                            <span className="text-slate-500 ml-1.5 truncate">
                              ({stat.calls} 次调用)
                            </span>
                          </div>
                          <span className="font-mono tabular-nums text-slate-700 shrink-0">
                            {stat.generatedImages && stat.generatedImages > 0
                              ? `${stat.generatedImages} 幅配图`
                              : `${((stat.inputTokens + stat.outputTokens) / 1000).toFixed(1)}k Tok`}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              {job.generatedFigures && job.generatedFigures.length > 0 && (
                <div className="space-y-1.5">
                  <div className="inline-flex items-center gap-1.5 font-semibold text-slate-900">
                    <ImageIcon className="w-3.5 h-3.5 text-blue-600" aria-hidden="true" />
                    <span>已嵌入 Nano Banana 配图 ({job.generatedFigures.length} 幅)</span>
                  </div>
                </div>
              )}
            </div>
          )}
        </section>

        {/* Conversational Follow-up Input: Live Supplement while running OR Seamless Expansion when completed */}
        {(isRunning ||
          canResumeJob ||
          (job.supplementalDirectives && job.supplementalDirectives.length > 0)) && (
          <LiveSupplementBar
            job={job}
            driveToken={driveToken}
            isSubmittingSupplement={isSubmittingSupplement}
            onSubmitSupplement={onSubmitSupplement}
          />
        )}

        {!isRunning &&
          !canResumeJob &&
          job.compiledMarkdown.trim().length > 0 &&
          onExpandCompletedJob && (
            <PostCompletionExpansionCard
              job={job}
              driveToken={driveToken}
              isExpanding={isExpandingJob}
              onExpandCompletedJob={onExpandCompletedJob}
              onLoadIntoComposerWithMemory={onLoadIntoComposerWithMemory}
            />
          )}
      </div>

      {/* =====================================================================
          RIGHT PANE: Live Academic Document & Native Vector PDF Artifact Canvas
         ===================================================================== */}
      <div className="min-w-0 space-y-3">
        {/* Sticky Artifact Toolbar (Claude Artifacts / Gemini Canvas Style — Single Crisp Row) */}
        <div className="bg-white border border-slate-200 rounded-xl px-3 py-2 flex items-center justify-between gap-2 sticky top-0 z-10 overflow-x-auto no-print">
          {/* Segmented Artifact View Tabs */}
          <div
            className="inline-flex items-center gap-0.5 p-1 bg-slate-100 rounded-lg shrink-0"
            role="tablist"
            aria-label="文档产物预览模式"
          >
            <button
              type="button"
              role="tab"
              aria-selected={artifactTab === 'canvas'}
              onClick={() => setArtifactTab('canvas')}
              className={`inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-semibold rounded-md transition-colors whitespace-nowrap shrink-0 ${
                artifactTab === 'canvas'
                  ? 'bg-white text-slate-900 shadow-2xs'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              <FileText className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
              <span>排版画布</span>
            </button>

            <button
              type="button"
              role="tab"
              aria-selected={artifactTab === 'native_pdf'}
              onClick={() => setArtifactTab('native_pdf')}
              className={`inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-semibold rounded-md transition-colors whitespace-nowrap shrink-0 ${
                artifactTab === 'native_pdf'
                  ? 'bg-white text-slate-900 shadow-2xs'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              <FileCheck2 className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
              <span>原生 PDF 预览</span>
            </button>

            <button
              type="button"
              role="tab"
              aria-selected={artifactTab === 'markdown'}
              onClick={() => setArtifactTab('markdown')}
              className={`inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-semibold rounded-md transition-colors whitespace-nowrap shrink-0 ${
                artifactTab === 'markdown'
                  ? 'bg-white text-slate-900 shadow-2xs'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              <Code2 className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
              <span>源稿</span>
            </button>
          </div>

          {/* Right Toolbar Actions: Compact Single-Line Cluster */}
          <div className="flex items-center gap-1.5 shrink-0">
            <span className="hidden 2xl:inline text-xs text-slate-500 font-mono tabular-nums whitespace-nowrap mr-1">
              {resolvedOrientation === 'landscape'
                ? '横版演示 297×210mm'
                : '竖版 A4 210×297mm'}
            </span>

            <button
              type="button"
              disabled={!activePreviewMarkdown}
              onClick={handleCopyMarkdown}
              className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium text-slate-700 bg-white border border-slate-200 rounded-lg hover:bg-slate-50 disabled:opacity-50 transition-colors whitespace-nowrap shrink-0"
            >
              {copiedSource ? (
                <>
                  <Check className="w-3.5 h-3.5 text-emerald-600" aria-hidden="true" />
                  <span>已复制</span>
                </>
              ) : (
                <>
                  <Copy className="w-3.5 h-3.5 text-slate-500" aria-hidden="true" />
                  <span>复制</span>
                </>
              )}
            </button>

            {job.driveArchive.status === 'archived' && job.driveArchive.webViewLink ? (
              <a
                href={job.driveArchive.webViewLink}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-semibold text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-lg hover:bg-emerald-100 transition-colors whitespace-nowrap shrink-0"
              >
                <ExternalLink className="w-3.5 h-3.5" aria-hidden="true" />
                <span>云盘预览</span>
              </a>
            ) : (
              <button
                type="button"
                disabled={!job.compiledMarkdown || isThisUploading || isRunning}
                onClick={() => onSyncToDrive(job)}
                className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-semibold text-blue-700 bg-blue-50 border border-blue-200 rounded-lg hover:bg-blue-100 disabled:opacity-50 transition-colors whitespace-nowrap shrink-0"
              >
                {isThisUploading ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" />
                ) : (
                  <CloudUpload className="w-3.5 h-3.5" aria-hidden="true" />
                )}
                <span>存云盘</span>
              </button>
            )}

            <button
              type="button"
              disabled={!activePreviewMarkdown}
              onClick={() => window.print()}
              aria-label="打印当前文档"
              title="打印当前文档"
              className="inline-flex items-center justify-center p-1.5 text-xs font-medium text-slate-600 bg-white border border-slate-200 rounded-lg hover:bg-slate-50 disabled:opacity-50 transition-colors shrink-0"
            >
              <Printer className="w-3.5 h-3.5" aria-hidden="true" />
            </button>

            <button
              type="button"
              disabled={!activePreviewMarkdown || isThisCompiling || job.stage === 'planning'}
              onClick={() => {
                if (selectedVolumeArtifact && onDownloadVolumePdf) {
                  void onDownloadVolumePdf(job, selectedVolumeArtifact);
                } else if (multiVolumes && onDownloadAllVolumes) {
                  void onDownloadAllVolumes(job);
                } else {
                  void onDownloadPdf(job);
                }
              }}
              className="inline-flex items-center gap-1 px-3 py-1.5 text-xs font-semibold text-white bg-blue-600 rounded-lg hover:bg-blue-700 disabled:opacity-50 transition-colors whitespace-nowrap shrink-0"
            >
              {isThisCompiling ? (
                <>
                  <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" />
                  <span className="font-mono tabular-nums">
                    {pdfCompileProgress
                      ? `编译 ${pdfCompileProgress.current}/${pdfCompileProgress.total}`
                      : '拉取中...'}
                  </span>
                </>
              ) : (
                <>
                  <Download className="w-3.5 h-3.5" aria-hidden="true" />
                  <span>
                    {selectedVolumeArtifact
                      ? `下载第 ${selectedVolumeArtifact.volumeIndex} 册`
                      : multiVolumes
                        ? `下载全 ${multiVolumes.length} 册`
                        : '下载 PDF'}
                  </span>
                </>
              )}
            </button>
          </div>
        </div>

        {/* ARTIFACT TAB 1: Live Streaming Typeset Paper Canvas */}
        {artifactTab === 'canvas' && (
          <div className="bg-slate-200/55 border border-slate-200 rounded-xl p-3 sm:p-6">
            <div
              className={`bg-white border border-slate-200/90 rounded-lg p-6 sm:p-11 mx-auto transition-all ${
                resolvedOrientation === 'landscape' ? 'max-w-[1040px]' : 'max-w-[830px]'
              }`}
            >
              <div className={`p-5 mb-7 border rounded-lg space-y-2 ${coverThemeClasses.box}`}>
                <div className={`text-xs font-mono tabular-nums ${coverThemeClasses.meta}`}>
                  {job.plan?.courseCode || 'CARBON-101'} ·{' '}
                  {job.plan?.subjectCategory || '学术专篇'} ·{' '}
                  {selectedVolumeArtifact && multiVolumes
                    ? `独立分册 ${selectedVolumeArtifact.volumeIndex}/${multiVolumes.length}（${selectedVolumeArtifact.fileName}）`
                    : job.mode === 'workbook'
                      ? '精编练习题册（附完整分步解析）'
                      : '深度扩展课程讲义'}{' '}
                  · {activeColorPalette.label} ·{' '}
                  {resolvedOrientation === 'landscape' ? '横版演示版式' : '竖版 A4'}
                </div>
                <h2 className={`text-2xl font-bold leading-tight ${coverThemeClasses.title}`}>
                  {selectedVolumeArtifact?.volumeTitle ||
                    job.plan?.documentTitle ||
                    '正在规划标题与结构...'}
                </h2>
                {(selectedVolumeArtifact?.subtitle || job.plan?.subtitle) && (
                  <p className="text-sm text-slate-600">
                    {selectedVolumeArtifact?.subtitle || job.plan?.subtitle}
                  </p>
                )}
              </div>

              {renderedHtml ? (
                <div className="space-y-6">
                  <article
                    className="academic-prose"
                    dangerouslySetInnerHTML={{ __html: renderedHtml }}
                  />
                  {isCanvasWindowed && (
                    <div className="pt-4 border-t border-slate-200 flex flex-wrap items-center justify-between gap-3 text-xs text-slate-600 no-print">
                      <span>
                        为保持万字级公式画布瞬时响应，当前先行渲染前{' '}
                        <strong className="font-mono tabular-nums">
                          {displayedCanvasMarkdown.length.toLocaleString()}
                        </strong>{' '}
                        / {activePreviewMarkdown.length.toLocaleString()} 字（导出与原生 PDF 预览均包含 100% 全文）。
                      </span>
                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          onClick={() => setArtifactTab('native_pdf')}
                          className="px-3 py-1.5 font-semibold text-blue-700 bg-blue-50 border border-blue-200 rounded-lg hover:bg-blue-100 transition-colors whitespace-nowrap shrink-0"
                        >
                          切换原生 PDF 预览全本
                        </button>
                        <button
                          type="button"
                          onClick={() => setExpandedFullCanvasJobId(currentSliceKey)}
                          className="px-3 py-1.5 font-semibold text-slate-800 bg-slate-100 border border-slate-200 rounded-lg hover:bg-slate-200 transition-colors whitespace-nowrap shrink-0"
                        >
                          展开渲染全部全文画布
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              ) : (
                <div className="py-20 text-center space-y-3">
                  <Loader2
                    className="w-6 h-6 animate-spin text-blue-600 mx-auto"
                    aria-hidden="true"
                  />
                  <p className="text-sm text-slate-600">
                    {selectedVolumeArtifact
                      ? `正在排队等待前序分册完成后自动生成《${selectedVolumeArtifact.volumeTitle}》...`
                      : 'Gemini 4 Carbon 正在流式规划大纲并即将在此实时渲染排版正文...'}
                  </p>
                </div>
              )}
            </div>
          </div>
        )}

        {/* ARTIFACT TAB 2: Native Vector PDF & Multi-Sheet Paginated Reader */}
        {artifactTab === 'native_pdf' && (
          <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
            <div className="px-4 py-2.5 bg-slate-50 border-b border-slate-200 flex flex-wrap items-center justify-between gap-2 text-xs text-slate-600">
              <span>
                矢量 PDF 阅览器（{resolvedOrientation === 'landscape' ? 'A4 横版 PPT 297×210mm' : 'A4 竖版 210×297mm'} · 仅点击下载时才会保存到本地）
              </span>
              <div className="flex items-center gap-2">
                {supportsInlineBrowserPdf && (
                  <div className="inline-flex items-center p-0.5 bg-slate-200/70 rounded-md">
                    <button
                      type="button"
                      onClick={() => setPdfRenderSubMode('browser_plugin')}
                      className={`px-2 py-0.5 text-[11px] font-medium rounded whitespace-nowrap shrink-0 ${
                        pdfRenderSubMode === 'browser_plugin'
                          ? 'bg-white text-slate-900'
                          : 'text-slate-600 hover:text-slate-900'
                      }`}
                    >
                      内置 PDF 器
                    </button>
                    <button
                      type="button"
                      onClick={() => setPdfRenderSubMode('paginated_sheets')}
                      className={`px-2 py-0.5 text-[11px] font-medium rounded whitespace-nowrap shrink-0 ${
                        pdfRenderSubMode === 'paginated_sheets'
                          ? 'bg-white text-slate-900'
                          : 'text-slate-600 hover:text-slate-900'
                      }`}
                    >
                      分页纸张视图
                    </button>
                  </div>
                )}

                <button
                  type="button"
                  disabled={!activePreviewMarkdown || isGeneratingSeedPreview}
                  onClick={() => {
                    if (isServerBackedJob) {
                      setPdfRefreshNonce((n) => n + 1);
                    } else if (supportsInlineBrowserPdf && pdfRenderSubMode === 'browser_plugin') {
                      void buildSeedPdfPreview();
                    }
                  }}
                  className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium text-slate-700 bg-white border border-slate-200 rounded hover:bg-slate-100 whitespace-nowrap shrink-0"
                >
                  <RefreshCw className="w-3 h-3" aria-hidden="true" />
                  <span>刷新</span>
                </button>

                {effectivePdfPreviewUrl && supportsInlineBrowserPdf && (
                  <a
                    href={effectivePdfPreviewUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-semibold text-blue-700 bg-blue-50 border border-blue-200 rounded hover:bg-blue-100 whitespace-nowrap shrink-0"
                  >
                    <ExternalLink className="w-3 h-3" aria-hidden="true" />
                    <span>独立窗口查看</span>
                  </a>
                )}
              </div>
            </div>

            {!activePreviewMarkdown.trim() ? (
              <div className="py-24 text-center space-y-3">
                <Loader2
                  className="w-6 h-6 animate-spin text-blue-600 mx-auto"
                  aria-hidden="true"
                />
                <p className="text-sm text-slate-600">
                  待首个章节模块生成后即可直接在此查看编译后的原生 PDF 页面...
                </p>
              </div>
            ) : supportsInlineBrowserPdf && pdfRenderSubMode === 'browser_plugin' ? (
              isGeneratingSeedPreview ? (
                <div className="py-24 text-center space-y-3">
                  <Loader2
                    className="w-6 h-6 animate-spin text-blue-600 mx-auto"
                    aria-hidden="true"
                  />
                  <p className="text-sm text-slate-600">正在生成示例文档原生 PDF 预览...</p>
                </div>
              ) : effectivePdfPreviewUrl ? (
                <iframe
                  key={effectivePdfPreviewUrl}
                  src={effectivePdfPreviewUrl}
                  title="原生矢量 PDF 预览"
                  className="w-full h-[78vh] min-h-[640px] bg-slate-100 border-0"
                />
              ) : (
                <div className="py-20 text-center space-y-3">
                  <p className="text-sm text-slate-600">点击上方「刷新」加载矢量 PDF 预览。</p>
                </div>
              )
            ) : (
              <div className="bg-slate-700/95 p-4 sm:p-7 max-h-[80vh] overflow-y-auto space-y-6">
                {paginatedPdfSheetsHtml.map((sheetHtml, idx) => (
                  <div
                    key={`pdf-sheet-${idx + 1}`}
                    className={`bg-white mx-auto rounded-sm shadow-sm border border-slate-300 flex flex-col justify-between ${
                      resolvedOrientation === 'landscape'
                        ? 'max-w-[980px] min-h-[650px] p-8 sm:p-10'
                        : 'max-w-[780px] min-h-[980px] p-8 sm:p-11'
                    }`}
                  >
                    <div className="space-y-5">
                      <div className="pb-2.5 border-b border-slate-200 flex items-center justify-between gap-4 text-[11px] text-slate-500 font-mono tabular-nums">
                        <span className="truncate font-sans font-medium text-slate-600">
                          {selectedVolumeArtifact?.volumeTitle ||
                            job.plan?.documentTitle ||
                            'Carbon 学术讲义与题册'}
                        </span>
                        <span className="shrink-0">
                          {job.plan?.courseCode || 'CARBON'} ·{' '}
                          {resolvedOrientation === 'landscape' ? '297×210mm PPT' : 'A4 210×297mm'}
                        </span>
                      </div>

                      {idx === 0 && (
                        <div className={`p-4 border rounded-lg space-y-1.5 ${coverThemeClasses.box}`}>
                          <div className={`text-[11px] font-mono tabular-nums ${coverThemeClasses.meta}`}>
                            {job.plan?.subjectCategory || '学术专篇'} · {activeColorPalette.label}
                          </div>
                          <h3 className={`text-xl font-bold leading-snug ${coverThemeClasses.title}`}>
                            {selectedVolumeArtifact?.volumeTitle || job.plan?.documentTitle}
                          </h3>
                        </div>
                      )}

                      <article
                        className="academic-prose"
                        dangerouslySetInnerHTML={{ __html: sheetHtml }}
                      />
                    </div>

                    <div className="pt-4 mt-8 border-t border-slate-100 flex items-center justify-between text-[11px] text-slate-400 font-mono tabular-nums">
                      <span>Carbon Academic Vector Typesetting</span>
                      <span>
                        Page {idx + 1} / {paginatedPdfSheetsHtml.length}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* ARTIFACT TAB 3: Clean Academic Markdown + LaTeX Source View */}
        {artifactTab === 'markdown' && (
          <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
            <div className="px-4 py-2.5 bg-slate-50 border-b border-slate-200 flex items-center justify-between text-xs text-slate-600 font-mono tabular-nums">
              <span>
                LaTeX + Markdown 学术源稿 · {activePreviewMarkdown.length.toLocaleString()} 字符
              </span>
              <button
                type="button"
                disabled={!activePreviewMarkdown}
                onClick={handleCopyMarkdown}
                className="inline-flex items-center gap-1 px-2.5 py-1 font-sans font-semibold text-blue-700 hover:underline whitespace-nowrap shrink-0"
              >
                {copiedSource ? '已复制到剪贴板' : '一键复制全文 Markdown'}
              </button>
            </div>
            <pre className="p-5 text-xs font-mono text-slate-800 whitespace-pre-wrap leading-relaxed max-h-[78vh] overflow-y-auto bg-white">
              {activePreviewMarkdown || '（正文正在流式生成中...）'}
            </pre>
          </div>
        )}
      </div>
    </div>
  );
};
