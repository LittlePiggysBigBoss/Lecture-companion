import React, { useMemo, useState } from 'react';
import {
  AlertCircle,
  ArrowLeft,
  BookCopy,
  CheckCircle2,
  CloudUpload,
  Download,
  ExternalLink,
  Eye,
  FileCheck2,
  FileText,
  FolderTree,
  GitBranchPlus,
  GitMerge,
  Layers,
  Link2,
  Loader2,
  Play,
  Printer,
  RotateCcw,
  Square,
} from 'lucide-react';
import type {
  DepthPreset,
  DocMode,
  GeneratedVolumeArtifact,
  PipelineJob,
  PostCompletionExpansionMode,
  ResumeStrategy,
  ScannedLinkResult,
  UploadedAttachment,
} from '../types';
import { renderAcademicMarkdown } from '../utils/markdownMathRenderer';
import {
  buildDriveArchivePath,
  calculateJobProgress,
  isJobResumable,
} from '../utils/pipelineLogic';
import { LiveSupplementBar } from './LiveSupplementBar';
import { PostCompletionExpansionCard } from './PostCompletionExpansionCard';

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
  const [subView, setSubView] = useState<'preview' | 'workflow'>('preview');
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

  const activePreviewMarkdown = selectedVolumeArtifact
    ? selectedVolumeArtifact.compiledMarkdown
    : job?.compiledMarkdown || '';

  const renderedHtml = useMemo(() => {
    if (!activePreviewMarkdown) return '';
    return renderAcademicMarkdown(activePreviewMarkdown);
  }, [activePreviewMarkdown]);

  if (!job) {
    return (
      <div className="max-w-2xl mx-auto py-16 text-center space-y-4 bg-white border border-slate-200 rounded-xl p-8">
        <FileCheck2 className="w-10 h-10 text-slate-400 mx-auto" aria-hidden="true" />
        <h2 className="text-lg font-semibold text-slate-900">当前暂无选中的流水线任务</h2>
        <p className="text-sm text-slate-500">
          前往工作台输入讲义或练习题册需求，系统将在此实时展示需求扩写、批次连续生成与 A4 排版效果。
        </p>
        <button
          type="button"
          onClick={onGoToComposer}
          className="inline-flex items-center gap-2 px-4 py-2 text-xs font-semibold text-white bg-blue-600 rounded-lg hover:bg-blue-700 transition-colors"
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
      label: '01. 需求扩写与极限批次编排',
      done: Boolean(job.plan),
      active: job.stage === 'planning',
    },
    {
      key: 'executing',
      label: '02. 云端连续生成与实时补充融合',
      done:
        job.stage === 'compiling_pdf' ||
        job.stage === 'uploading_drive' ||
        job.stage === 'completed',
      active: job.stage === 'executing',
    },
    {
      key: 'compiling_pdf',
      label: '03. A4 学术公式排版与 PDF 编译',
      done:
        job.stage === 'uploading_drive' ||
        job.stage === 'completed' ||
        Boolean(job.serverPdfReady),
      active: job.stage === 'compiling_pdf' || isThisCompiling,
    },
    {
      key: 'uploading_drive',
      label: '04. 托管至个人 Google Cloud 云盘',
      done: job.driveArchive.status === 'archived',
      active: job.stage === 'uploading_drive' || isThisUploading,
    },
  ];

  return (
    <div className="max-w-5xl mx-auto space-y-6">
      {/* Top Summary & Action Header */}
      <div className="bg-white border border-slate-200 rounded-xl p-5 space-y-4">
        <div className="space-y-3">
          <div className="space-y-1.5 min-w-0">
            {/* Unboxed Clean Metadata */}
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-slate-500 font-mono tabular-nums">
              <span>{job.plan?.courseCode || 'CARBON-AUTO'}</span>
              <span aria-hidden="true">·</span>
              <span className="font-sans">{job.plan?.subjectCategory || '正在识别学科...'}</span>
              <span aria-hidden="true">·</span>
              <span className="font-sans">
                {job.mode === 'workbook' ? '练习题册 PDF' : '课程讲义 PDF'}
              </span>
              <span aria-hidden="true">·</span>
              <span>{job.charCount.toLocaleString()} 字/词</span>
              <span aria-hidden="true">·</span>
              <span>{job.formulaCount} 处公式</span>
              <span aria-hidden="true">·</span>
              <span>约 {job.estimatedPages} 页 A4</span>
              {multiVolumes && (
                <>
                  <span aria-hidden="true">·</span>
                  <span className="font-sans font-semibold text-blue-700">
                    分册输出 {multiVolumes.length} 份独立 PDF
                  </span>
                </>
              )}
              {job.executionHost === 'server_cloud' && (
                <>
                  <span aria-hidden="true">·</span>
                  <span className="font-sans text-blue-700">多端云同步托管</span>
                </>
              )}
              {typeof job.expansionCount === 'number' && job.expansionCount > 0 && (
                <>
                  <span aria-hidden="true">·</span>
                  <span className="font-sans text-emerald-700">
                    已无缝扩编 {job.expansionCount} 次
                  </span>
                </>
              )}
              {parentJob && onSelectJob ? (
                <>
                  <span aria-hidden="true">·</span>
                  <button
                    type="button"
                    onClick={() => onSelectJob(parentJob.id)}
                    className="inline-flex items-center gap-1 font-sans text-blue-700 hover:underline"
                  >
                    <GitBranchPlus className="w-3 h-3 shrink-0" aria-hidden="true" />
                    <span>
                      长上下文派生自《
                      {(parentJob.plan?.documentTitle || parentJob.rawUserPrompt).slice(0, 18)}
                      》
                    </span>
                  </button>
                </>
              ) : (
                job.sourceContextJobIds &&
                job.sourceContextJobIds.length > 0 && (
                  <>
                    <span aria-hidden="true">·</span>
                    <span className="font-sans text-blue-700">
                      已绑定 {job.sourceContextJobIds.length} 份长上下文基准
                    </span>
                  </>
                )
              )}
              {job.scannedLinks && job.scannedLinks.length > 0 && (
                <>
                  <span aria-hidden="true">·</span>
                  <span className="inline-flex items-center gap-1 font-sans text-slate-700">
                    <Link2 className="w-3 h-3 text-blue-600 shrink-0" aria-hidden="true" />
                    <span>已解析 {job.scannedLinks.length} 个链接</span>
                  </span>
                </>
              )}
              {job.billing && (
                <>
                  <span aria-hidden="true">·</span>
                  <span className="font-sans text-slate-700">
                    {job.billing.billingMode === 'super_admin_free'
                      ? '超管免计费'
                      : job.billing.billingMode === 'monthly_pro_quota'
                        ? '包月会员配额'
                        : `按页计费 ¥${job.billing.chargedCny.toFixed(2)}`}
                  </span>
                </>
              )}
            </div>

            <h1 className="text-xl sm:text-2xl font-bold text-slate-900 leading-snug">
              {job.plan?.documentTitle || '正在基于 Gemini 4 Carbon 扩展分析您的学术需求...'}
            </h1>
            {job.plan?.subtitle && (
              <p className="text-sm text-slate-600">{job.plan.subtitle}</p>
            )}
          </div>

          {/* Primary Action Toolbar (Personal Google Cloud Hosting + On-Demand Local Download) */}
          <div className="flex flex-wrap items-center gap-2.5 pt-1 no-print">
            {isRunning && (
              <button
                type="button"
                onClick={onCancelRunningJob}
                className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium text-red-700 bg-red-50 border border-red-200 rounded-lg hover:bg-red-100 transition-colors whitespace-nowrap shrink-0"
              >
                <Square className="w-3.5 h-3.5 fill-current" aria-hidden="true" />
                <span>暂停流水线（保留断点）</span>
              </button>
            )}

            {job.driveArchive.status === 'archived' && job.driveArchive.webViewLink ? (
              <a
                href={job.driveArchive.webViewLink}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold text-white bg-emerald-600 rounded-lg hover:bg-emerald-700 transition-colors whitespace-nowrap shrink-0"
              >
                <ExternalLink className="w-3.5 h-3.5" aria-hidden="true" />
                <span>在个人 Google Cloud 预览</span>
              </a>
            ) : (
              <button
                type="button"
                disabled={!job.compiledMarkdown || isThisUploading || isRunning}
                onClick={() => onSyncToDrive(job)}
                className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold text-blue-700 bg-blue-50 border border-blue-200 rounded-lg hover:bg-blue-100 disabled:opacity-50 transition-colors whitespace-nowrap shrink-0"
              >
                {isThisUploading ? (
                  <>
                    <Loader2 className="w-3.5 h-3.5 animate-spin text-blue-600" aria-hidden="true" />
                    <span>正在同步至个人 Google Cloud...</span>
                  </>
                ) : (
                  <>
                    <CloudUpload className="w-3.5 h-3.5 text-blue-600" aria-hidden="true" />
                    <span>
                      {hasDriveToken ? '存入个人 Google Cloud' : '登录并存入个人云'}
                    </span>
                  </>
                )}
              </button>
            )}

            {job.driveArchive.gcsWebLink && (
              <a
                href={job.driveArchive.gcsWebLink}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium text-slate-700 bg-white border border-slate-200 rounded-lg hover:bg-slate-50 transition-colors whitespace-nowrap shrink-0"
              >
                <ExternalLink className="w-3.5 h-3.5 text-slate-500" aria-hidden="true" />
                <span>GCS Bucket 对象</span>
              </a>
            )}

            {job.driveArchive.draftWebViewLink && (
              <a
                href={job.driveArchive.draftWebViewLink}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium text-slate-700 bg-white border border-slate-200 rounded-lg hover:bg-slate-50 transition-colors whitespace-nowrap shrink-0"
              >
                <FileText className="w-3.5 h-3.5 text-slate-500" aria-hidden="true" />
                <span>云盘实时源稿</span>
              </a>
            )}

            <button
              type="button"
              disabled={!job.compiledMarkdown || isThisCompiling || job.stage === 'planning'}
              onClick={() =>
                multiVolumes && onDownloadAllVolumes
                  ? onDownloadAllVolumes(job)
                  : onDownloadPdf(job)
              }
              className="inline-flex items-center gap-2 px-4 py-2 text-xs font-semibold text-white bg-blue-600 rounded-lg hover:bg-blue-700 disabled:opacity-50 transition-colors whitespace-nowrap shrink-0"
            >
              {isThisCompiling ? (
                <>
                  <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" />
                  <span className="font-mono tabular-nums">
                    {pdfCompileProgress
                      ? `排版编译 ${pdfCompileProgress.current}/${pdfCompileProgress.total} 页...`
                      : '正在按需拉取 PDF...'}
                  </span>
                </>
              ) : (
                <>
                  <Download className="w-3.5 h-3.5" aria-hidden="true" />
                  <span>
                    {multiVolumes
                      ? `一键下载全部 ${multiVolumes.length} 份分册 PDF`
                      : job.serverPdfReady || hasCachedPdf
                        ? '按需下载 PDF 到本地'
                        : '编译并下载到本地'}
                  </span>
                </>
              )}
            </button>

            <button
              type="button"
              disabled={!job.compiledMarkdown}
              onClick={() => window.print()}
              aria-label="打印当前学术讲义"
              className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium text-slate-600 bg-white border border-slate-200 rounded-lg hover:bg-slate-50 disabled:opacity-50 transition-colors whitespace-nowrap shrink-0"
            >
              <Printer className="w-3.5 h-3.5" aria-hidden="true" />
              <span className="hidden sm:inline">打印视图</span>
            </button>
          </div>
        </div>

        {/* Progress Bar & 4-Stage Pipeline Tracker */}
        <div className="space-y-3 pt-2 border-t border-slate-100 no-print">
          <div className="flex items-center justify-between text-xs">
            <span className="font-medium text-slate-700">
              {job.stage === 'planning' &&
                '云端后台正在调用 Gemini 4 Carbon 整合需求并动态拆解单次调用极限轮次（不固定轮次，关机断网不影响执行）...'}
              {job.stage === 'executing' &&
                `云端后台正在执行第 ${Math.max(1, progressInfo.activeBatchIndex + 1)}/${progressInfo.totalBatches} 轮极限生成（已自动续写 ${progressInfo.totalContinuations} 次，多终端实时同步）...`}
              {job.stage === 'compiling_pdf' &&
                (multiVolumes
                  ? `云端正在分别排版编译 ${multiVolumes.length} 份独立分册 A4 PDF...`
                  : '云端正在编译高精度矢量 A4 PDF 并准备上传至您的个人 Google Cloud...')}
              {job.stage === 'uploading_drive' &&
                `正在把生成的${multiVolumes ? ` ${multiVolumes.length} 份独立分册 PDF` : ' PDF'} 托管至您个人的 Google Cloud「${archivePathObj.fullPath}」...`}
              {job.stage === 'completed' &&
                `全自动自适应工作流执行完毕 · 共完成 ${progressInfo.totalBatches} 轮单次调用极限生成${
                  multiVolumes ? ` · 已独立输出 ${multiVolumes.length} 份分册 PDF` : ''
                }`}
              {job.stage === 'cancelled' &&
                '任务已暂停，所有已完成轮次与半截文稿均已安全锁定，可随时从断点继续'}
              {job.stage === 'error' &&
                '步骤执行中断（已保存断点进度，可直接继续生成或重跑失败步骤）'}
            </span>
            <span className="font-mono font-semibold text-slate-900 tabular-nums">
              {progressInfo.percent}%
            </span>
          </div>

          <div className="w-full h-2 bg-slate-100 rounded-full overflow-hidden">
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

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 pt-1">
            {stageSteps.map((s) => (
              <div key={s.key} className="flex items-center gap-2 text-xs py-1">
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

          {/* Personal Google Cloud Path & On-Demand Policy Feedback */}
          <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-slate-600 pt-1">
            <div className="flex items-center gap-2 min-w-0">
              <FolderTree className="w-3.5 h-3.5 text-slate-400 shrink-0" aria-hidden="true" />
              <span className="truncate">
                个人云归档路径：
                <span className="font-mono text-slate-800">
                  {job.driveArchive.folderPath || archivePathObj.fullPath}
                </span>
                {job.driveArchive.gcsObjectUri && (
                  <span className="font-mono text-blue-700 ml-2">
                    ({job.driveArchive.gcsObjectUri})
                  </span>
                )}
              </span>
            </div>
            <div className="flex flex-wrap items-center gap-2 shrink-0">
              {job.driveArchive.lastSyncedAt && (
                <span className="text-slate-500 font-mono tabular-nums">
                  云端快照同步于{' '}
                  {new Date(job.driveArchive.lastSyncedAt).toLocaleTimeString('zh-CN', {
                    hour: '2-digit',
                    minute: '2-digit',
                    second: '2-digit',
                  })}
                </span>
              )}
              {job.driveArchive.status === 'archived' && (
                <span className="text-emerald-700 font-semibold">
                  已驻留您的 Google Cloud（点击下载时才保存到本地）
                </span>
              )}
              {job.driveArchive.status === 'pending_auth' && (
                <span className="text-amber-700">待授权个人 Google Cloud 后一键直传归档</span>
              )}
              {job.driveArchive.status === 'error' && (
                <span className="text-red-600">云端归档异常：{job.driveArchive.error}</span>
              )}
            </div>
          </div>

          {/* Checkpoint Error Recovery & Retry Control Box */}
          {canResumeJob && (
            <div
              role="alert"
              className={`p-4 rounded-xl border flex flex-col md:flex-row md:items-center justify-between gap-4 ${
                job.stage === 'error'
                  ? 'bg-red-50/70 border-red-200 text-red-900'
                  : 'bg-amber-50/70 border-amber-200 text-amber-950'
              }`}
            >
              <div className="space-y-1 min-w-0 flex-1">
                <div className="flex items-center gap-2 text-xs font-semibold">
                  <AlertCircle
                    className={`w-4 h-4 shrink-0 ${
                      job.stage === 'error' ? 'text-red-600' : 'text-amber-600'
                    }`}
                    aria-hidden="true"
                  />
                  <span>
                    {job.stage === 'error'
                      ? '任务步骤发生中断 —— 已生成的进度已完整保护，无需删除重来'
                      : job.stage === 'cancelled'
                        ? '任务处于暂停断点状态 —— 可随时在云端后台接续执行'
                        : '云盘上传未完成 —— 可直接重试归档'}
                  </span>
                </div>
                <p className="text-xs leading-relaxed opacity-90">
                  {job.errorMessage ||
                    job.driveArchive.error ||
                    '您可以选择从精确断点处无缝续写，或仅重跑当前失败的步骤批次。恢复后将在服务端后台独立运行，断网不影响进度。'}
                </p>
                <p className="text-[11px] font-mono tabular-nums opacity-80">
                  已保留进度：已完成 {progressInfo.completedBatches}/
                  {progressInfo.totalBatches || 1} 个完整批次
                  {preservedPartialChars > 0
                    ? ` · 当前中断批次已保留 ${preservedPartialChars.toLocaleString()} 字符（断点续写将直接拼接）`
                    : ` · 累计已生成 ${job.charCount.toLocaleString()} 字/词`}
                </p>
              </div>

              <div className="flex flex-wrap items-center gap-2.5 shrink-0">
                <button
                  type="button"
                  disabled={isThisResuming}
                  onClick={() => onResumeJob(job, 'continue')}
                  className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold text-white bg-blue-600 rounded-lg hover:bg-blue-700 disabled:opacity-60 transition-colors whitespace-nowrap shrink-0"
                >
                  {isThisResuming ? (
                    <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" />
                  ) : (
                    <Play className="w-3.5 h-3.5 fill-current" aria-hidden="true" />
                  )}
                  <span>断点继续生成</span>
                </button>

                <button
                  type="button"
                  disabled={isThisResuming}
                  onClick={() => onResumeJob(job, 'retry_batch')}
                  className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold text-slate-800 bg-white border border-slate-300 rounded-lg hover:bg-slate-50 disabled:opacity-60 transition-colors whitespace-nowrap shrink-0"
                >
                  <RotateCcw className="w-3.5 h-3.5 text-slate-600" aria-hidden="true" />
                  <span>重跑失败步骤</span>
                </button>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Multi-Volume Independent PDF Files Workbench (Above the fold for multi-volume jobs) */}
      {multiVolumes && (
        <section
          aria-label="多份独立分册文件输出工作台"
          className="bg-white border border-slate-200 rounded-xl divide-y divide-slate-200 no-print"
        >
          <div className="px-5 py-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <div className="space-y-0.5">
              <div className="flex items-center gap-2">
                <BookCopy className="w-4 h-4 text-blue-600 shrink-0" aria-hidden="true" />
                <h2 className="text-sm font-semibold text-slate-900">
                  分册独立文件输出工作台（已自动拆分为 {multiVolumes.length} 份独立 PDF 文件）
                </h2>
              </div>
              <p className="text-xs text-slate-500">
                每份分册均拥有独立封面、独立页码与独立文件名，可分别在线预览 A4 排版、在 Google Drive 独立打开或单独下载。
              </p>
            </div>

            <div className="flex flex-wrap items-center gap-2 shrink-0">
              <button
                type="button"
                onClick={() => {
                  setVolumeSelection({ jobId: job.id, volumeId: 'all' });
                  setSubView('preview');
                }}
                className={`px-3 py-1.5 text-xs font-semibold rounded-lg border transition-colors whitespace-nowrap shrink-0 ${
                  activeVolumeId === 'all' && subView === 'preview'
                    ? 'bg-slate-900 text-white border-slate-900'
                    : 'bg-white text-slate-700 border-slate-200 hover:bg-slate-50'
                }`}
              >
                全册合编连览
              </button>

              {onDownloadAllVolumes && (
                <button
                  type="button"
                  disabled={
                    isThisCompiling ||
                    !multiVolumes.some((v) => v.compiledMarkdown.trim().length > 0)
                  }
                  onClick={() => onDownloadAllVolumes(job)}
                  className="inline-flex items-center gap-1.5 px-3.5 py-1.5 text-xs font-semibold text-white bg-blue-600 rounded-lg hover:bg-blue-700 disabled:opacity-50 transition-colors whitespace-nowrap shrink-0"
                >
                  <Download className="w-3.5 h-3.5" aria-hidden="true" />
                  <span>一键下载全部 {multiVolumes.length} 份 PDF</span>
                </button>
              )}
            </div>
          </div>

          <div className="divide-y divide-slate-100">
            {multiVolumes.map((vol) => {
              const isSelectedForPreview =
                subView === 'preview' && activeVolumeId === vol.volumeId;
              const isVolCompiling =
                compilingVolumeKey === `${job.id}:${vol.volumeId}` || isThisCompiling;
              const hasContent = vol.compiledMarkdown.trim().length > 0;

              return (
                <div
                  key={vol.volumeId}
                  className={`px-5 py-3.5 flex flex-col lg:flex-row lg:items-center justify-between gap-3 transition-colors ${
                    isSelectedForPreview ? 'bg-blue-50/40' : 'hover:bg-slate-50/70'
                  }`}
                >
                  <div className="min-w-0 flex-1 space-y-1">
                    <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500 font-mono tabular-nums">
                      <span className="font-semibold text-blue-700">
                        第 {vol.volumeIndex}/{multiVolumes.length} 分册
                      </span>
                      <span aria-hidden="true">·</span>
                      <span className="truncate max-w-[260px] text-slate-700">{vol.fileName}</span>
                      <span aria-hidden="true">·</span>
                      <span>{vol.charCount.toLocaleString()} 字</span>
                      <span aria-hidden="true">·</span>
                      <span>{vol.formulaCount} 处公式</span>
                      <span aria-hidden="true">·</span>
                      <span>约 {vol.estimatedPages} 页 A4</span>
                      <span aria-hidden="true">·</span>
                      <span className="font-sans">
                        {vol.status === 'completed' && (
                          <span className="text-emerald-700 font-medium">独立文件已就绪</span>
                        )}
                        {vol.status === 'generating' && (
                          <span className="text-blue-700 font-medium">正在生成本分册...</span>
                        )}
                        {vol.status === 'compiling_pdf' && (
                          <span className="text-blue-700 font-medium">正在编译独立 PDF...</span>
                        )}
                        {vol.status === 'uploading_drive' && (
                          <span className="text-blue-700 font-medium">正在上传云盘...</span>
                        )}
                        {vol.status === 'pending' && (
                          <span className="text-slate-500">排队等待前序分册完成</span>
                        )}
                        {vol.status === 'error' && (
                          <span className="text-red-600 font-medium">待断点续跑</span>
                        )}
                      </span>
                    </div>

                    <div className="text-sm font-semibold text-slate-900 truncate">
                      {vol.volumeTitle}
                    </div>
                    {vol.subtitle && (
                      <div className="text-xs text-slate-500 truncate">{vol.subtitle}</div>
                    )}
                  </div>

                  <div className="flex flex-wrap items-center gap-2 shrink-0">
                    <button
                      type="button"
                      onClick={() => {
                        setVolumeSelection({ jobId: job.id, volumeId: vol.volumeId });
                        setSubView('preview');
                      }}
                      className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-lg border transition-colors whitespace-nowrap shrink-0 ${
                        isSelectedForPreview
                          ? 'bg-blue-600 text-white border-blue-600'
                          : 'bg-white text-slate-700 border-slate-200 hover:bg-slate-100'
                      }`}
                    >
                      <Eye className="w-3.5 h-3.5" aria-hidden="true" />
                      <span>{isSelectedForPreview ? '当前正在预览' : '预览此分册'}</span>
                    </button>

                    {vol.driveWebViewLink && (
                      <a
                        href={vol.driveWebViewLink}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-lg hover:bg-emerald-100 transition-colors whitespace-nowrap shrink-0"
                      >
                        <ExternalLink className="w-3.5 h-3.5" aria-hidden="true" />
                        <span>云盘预览此分册</span>
                      </a>
                    )}

                    {onDownloadVolumePdf && (
                      <button
                        type="button"
                        disabled={!hasContent || isVolCompiling}
                        onClick={() => onDownloadVolumePdf(job, vol)}
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-slate-900 bg-white border border-slate-300 rounded-lg hover:bg-slate-100 disabled:opacity-50 transition-colors whitespace-nowrap shrink-0"
                      >
                        {isVolCompiling ? (
                          <Loader2 className="w-3.5 h-3.5 animate-spin text-blue-600" aria-hidden="true" />
                        ) : (
                          <Download className="w-3.5 h-3.5 text-blue-600" aria-hidden="true" />
                        )}
                        <span>下载此分册 PDF</span>
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      )}

      {/* Post-Completion Long-Context Task Expansion (Seamless In-Place Chapter/Problem Expansion OR Companion Derive) */}
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

      {/* Live Mid-Execution Supplemental Prompt + Unlimited Upload + Voice Input + Link Recognition */}
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

      {/* View Switcher: A4 Academic Preview vs. Consolidated Spec & Adaptive Round Flow */}
      <div className="flex flex-wrap items-center justify-between gap-3 no-print">
        <div
          className="inline-flex max-w-full overflow-x-auto items-center gap-1 p-1 bg-slate-200/70 rounded-lg"
          role="tablist"
        >
          <button
            type="button"
            role="tab"
            aria-selected={subView === 'preview'}
            onClick={() => setSubView('preview')}
            className={`px-2.5 sm:px-3.5 py-1.5 text-xs font-semibold rounded-md transition-colors whitespace-nowrap shrink-0 ${
              subView === 'preview'
                ? 'bg-white text-slate-900 shadow-xs'
                : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            {selectedVolumeArtifact
              ? `A4 排版预览 · 第 ${selectedVolumeArtifact.volumeIndex} 分册`
              : 'A4 排版预览'}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={subView === 'workflow'}
            onClick={() => setSubView('workflow')}
            className={`inline-flex items-center gap-1.5 px-2.5 sm:px-3.5 py-1.5 text-xs font-semibold rounded-md transition-colors whitespace-nowrap shrink-0 ${
              subView === 'workflow'
                ? 'bg-white text-slate-900 shadow-xs'
                : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            <Layers className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
            <span>需求整合与自适应轮次流 ({job.batches.length})</span>
          </button>
        </div>

        {job.attachmentsMeta.length > 0 && (
          <span className="text-xs text-slate-500">
            已融合参考附件：{job.attachmentsMeta.map((a) => a.name).join(' · ')}
          </span>
        )}
      </div>

      {subView === 'preview' ? (
        <div className="bg-white border border-slate-200 rounded-xl p-6 sm:p-12 max-w-[850px] mx-auto">
          <div className="pb-6 mb-6 border-b border-slate-200 space-y-2">
            <div className="text-xs text-slate-500 font-mono tabular-nums">
              {job.plan?.courseCode || 'CARBON-101'} · {job.plan?.subjectCategory || '学术专篇'} ·{' '}
              {selectedVolumeArtifact && multiVolumes
                ? `独立分册 ${selectedVolumeArtifact.volumeIndex}/${multiVolumes.length}（${selectedVolumeArtifact.fileName}）`
                : job.mode === 'workbook'
                  ? '精编练习题册（附完整分步解析）'
                  : '深度扩展课程讲义'}
            </div>
            <h2 className="text-2xl font-bold text-slate-900 leading-tight">
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
            <article
              className="academic-prose"
              dangerouslySetInnerHTML={{ __html: renderedHtml }}
            />
          ) : (
            <div className="py-16 text-center space-y-3">
              <Loader2
                className="w-6 h-6 animate-spin text-blue-600 mx-auto"
                aria-hidden="true"
              />
              <p className="text-sm text-slate-600">
                {selectedVolumeArtifact
                  ? `正在等待前序分册完成后自动启动《${selectedVolumeArtifact.volumeTitle}》满载生成...`
                  : 'Gemini 4 Carbon 正在构建扩写编纂规范并启动第 1 轮单次调用极限撰写...'}
              </p>
            </div>
          )}
        </div>
      ) : (
        <div className="space-y-6">
          {/* Consolidated Requirements & Token Optimization Card */}
          {job.consolidatedRequirements && (
            <div className="bg-white border border-slate-200 rounded-xl p-6 space-y-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <GitMerge className="w-4 h-4 text-blue-600 shrink-0" aria-hidden="true" />
                  <h2 className="text-sm font-semibold text-slate-900">
                    智能需求整合总表与变更动态跟进（v{job.consolidatedRequirements.version}）
                  </h2>
                </div>
                <div className="flex flex-wrap items-center gap-2 text-xs font-mono tabular-nums text-slate-600">
                  <span>
                    活跃规则{' '}
                    {
                      job.consolidatedRequirements.activeRules.filter((r) => r.status === 'active')
                        .length
                    }{' '}
                    条
                  </span>
                  <span aria-hidden="true">·</span>
                  <span>
                    已自动消解冲突/旧规则{' '}
                    {
                      job.consolidatedRequirements.activeRules.filter(
                        (r) => r.status === 'superseded'
                      ).length
                    }{' '}
                    条
                  </span>
                  {job.consolidatedRequirements.tokenSavingsEstimatePct > 0 && (
                    <>
                      <span aria-hidden="true">·</span>
                      <span className="text-emerald-700 font-semibold">
                        续写上下文精简节省约 {job.consolidatedRequirements.tokenSavingsEstimatePct}% Token
                      </span>
                    </>
                  )}
                </div>
              </div>

              <div className="bg-slate-50 border border-slate-200 rounded-lg p-3.5 text-xs text-slate-800 whitespace-pre-line leading-relaxed">
                {job.consolidatedRequirements.synthesizedMasterBrief}
              </div>

              {job.consolidatedRequirements.activeRules.length > 0 && (
                <div className="space-y-1.5">
                  <h3 className="text-xs font-semibold text-slate-700">
                    结构化原子需求清单（自动去重并标记已被后续指令覆盖的旧要求）
                  </h3>
                  <div className="divide-y divide-slate-100 border border-slate-200 rounded-lg">
                    {job.consolidatedRequirements.activeRules.map((rule) => (
                      <div
                        key={rule.id}
                        className="px-3 py-2 text-xs flex flex-wrap items-start justify-between gap-2"
                      >
                        <div className="min-w-0 flex-1">
                          <span className="font-mono text-slate-500 mr-2">[{rule.sourceLabel}]</span>
                          <span
                            className={
                              rule.status === 'superseded'
                                ? 'line-through text-slate-400'
                                : 'text-slate-800'
                            }
                          >
                            {rule.summary}
                          </span>
                          {rule.status === 'superseded' && rule.supersededBy && (
                            <span className="ml-2 text-amber-700">
                              （已由「{rule.supersededBy}」覆盖更新）
                            </span>
                          )}
                        </div>
                        <span
                          className={`font-mono text-[11px] shrink-0 ${
                            rule.status === 'superseded' ? 'text-slate-400' : 'text-emerald-700'
                          }`}
                        >
                          {rule.status === 'superseded' ? '已覆盖淘汰' : '当前生效'}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {job.consolidatedRequirements.changeLog.length > 0 && (
                <div className="space-y-1 pt-1">
                  <h3 className="text-xs font-semibold text-slate-700">需求变更演进轨迹</h3>
                  <ul className="space-y-1 text-xs text-slate-600 font-mono">
                    {job.consolidatedRequirements.changeLog.map((entry, idx) => (
                      <li key={idx}>{entry}</li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}
          <div className="bg-white border border-slate-200 rounded-xl p-6 space-y-5">
            <div className="space-y-1.5">
              <h2 className="text-sm font-semibold text-slate-900">原始用户输入指令</h2>
              <p className="text-sm text-slate-600 bg-slate-50 border border-slate-200 rounded-lg p-3.5">
                {job.rawUserPrompt || '（仅基于上传参考附件驱动扩写）'}
              </p>
            </div>

            {job.scannedLinks && job.scannedLinks.length > 0 && (
              <div className="space-y-2 pt-2 border-t border-slate-100">
                <h2 className="text-sm font-semibold text-slate-900">
                  自动识别并抓取扫描的文件与云盘链接 ({job.scannedLinks.length})
                </h2>
                <div className="space-y-1.5 text-xs text-slate-700">
                  {job.scannedLinks.map((lnk) => (
                    <div
                      key={lnk.url}
                      className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 bg-slate-50 border border-slate-200 rounded-lg"
                    >
                      <div className="min-w-0 flex-1 truncate">
                        <span className="font-semibold text-slate-900">
                          {lnk.title || lnk.url}
                        </span>
                        <span className="text-slate-500 font-mono ml-2">{lnk.url}</span>
                      </div>
                      <span
                        className={`font-mono whitespace-nowrap ${
                          lnk.status === 'ready'
                            ? 'text-emerald-700'
                            : lnk.status === 'warning'
                              ? 'text-amber-700'
                              : 'text-red-600'
                        }`}
                      >
                        {lnk.status === 'ready'
                          ? '已抓取并注入多模态长上下文'
                          : lnk.errorMessage || '已启用 URL 实时检索'}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {job.plan && (
              <>
                <div className="space-y-1.5 pt-2 border-t border-slate-100">
                  <h2 className="text-sm font-semibold text-slate-900">
                    Carbon 自动扩写完善后的《学术编纂总纲》
                  </h2>
                  <p className="text-sm text-slate-700 leading-relaxed">
                    {job.plan.expandedPrompt}
                  </p>
                </div>

                {job.plan.pedagogicalGoals.length > 0 && (
                  <div className="space-y-2 pt-2 border-t border-slate-100">
                    <h3 className="text-sm font-semibold text-slate-900">核心教学与训练目标</h3>
                    <ul className="space-y-1.5 text-sm text-slate-700 list-disc pl-5">
                      {job.plan.pedagogicalGoals.map((goal, idx) => (
                        <li key={idx}>{goal}</li>
                      ))}
                    </ul>
                  </div>
                )}
              </>
            )}
          </div>

          <div className="bg-white border border-slate-200 rounded-xl divide-y divide-slate-200">
            <div className="px-6 py-4 flex flex-col sm:flex-row sm:items-center justify-between gap-2">
              <div className="space-y-0.5">
                <h2 className="text-sm font-semibold text-slate-900">
                  单次调用极限自适应工作流（不固定轮次 · 按实际体量动态拆解）
                </h2>
                {job.plan?.adaptiveStrategyNote && (
                  <p className="text-xs text-slate-500">{job.plan.adaptiveStrategyNote}</p>
                )}
              </div>
              <span className="text-xs text-slate-500 font-mono tabular-nums shrink-0">
                动态拆解共 {job.batches.length} 轮 · 自动无缝续写 {progressInfo.totalContinuations} 次
              </span>
            </div>

            {job.batches.map((b, idx) => {
              const spec = job.plan?.batches[idx];
              const volIndex = b.volumeIndex || spec?.volumeIndex;
              return (
                <div key={b.batchIndex} className="p-6 space-y-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex items-center gap-2.5">
                      {b.status === 'completed' ? (
                        <CheckCircle2
                          className="w-4 h-4 text-emerald-600 shrink-0"
                          aria-hidden="true"
                        />
                      ) : b.status === 'running' || b.status === 'continuing' ? (
                        <Loader2
                          className="w-4 h-4 animate-spin text-blue-600 shrink-0"
                          aria-hidden="true"
                        />
                      ) : b.status === 'error' ? (
                        <AlertCircle
                          className="w-4 h-4 text-red-600 shrink-0"
                          aria-hidden="true"
                        />
                      ) : (
                        <span
                          className="w-4 h-4 rounded-full border border-slate-300 shrink-0"
                          aria-hidden="true"
                        />
                      )}
                      <h3 className="text-sm font-semibold text-slate-900">
                        第 {b.batchIndex}/{job.batches.length} 轮
                        {multiVolumes && volIndex ? `（第 ${volIndex} 分册）` : ''}: {b.title}
                      </h3>
                    </div>

                    <div className="flex flex-wrap items-center gap-3">
                      <div className="text-xs text-slate-500 font-mono tabular-nums">
                        <span>
                          {b.status === 'completed' && '已完成'}
                          {b.status === 'running' && '正在满载生成'}
                          {b.status === 'continuing' &&
                            `正在自动续写 (第 ${b.continuationCount} 次)`}
                          {b.status === 'pending' && '等待队列'}
                          {b.status === 'error' && '步骤中断'}
                        </span>
                        <span aria-hidden="true"> · </span>
                        <span>已输出 {b.markdownContent.length.toLocaleString()} 字符</span>
                        {b.continuationCount > 0 && (
                          <>
                            <span aria-hidden="true"> · </span>
                            <span className="text-blue-700">
                              自动续写 {b.continuationCount} 次
                            </span>
                          </>
                        )}
                      </div>

                      {!isRunning && (
                        <div className="flex items-center gap-2">
                          {b.status !== 'completed' && b.markdownContent.trim().length > 0 && (
                            <button
                              type="button"
                              disabled={isThisResuming}
                              onClick={() => onResumeJob(job, 'continue', idx)}
                              className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-semibold text-white bg-blue-600 rounded-md hover:bg-blue-700 disabled:opacity-60 transition-colors whitespace-nowrap shrink-0"
                            >
                              <Play className="w-3 h-3 fill-current" aria-hidden="true" />
                              <span>从断点续写此批次</span>
                            </button>
                          )}
                          <button
                            type="button"
                            disabled={isThisResuming}
                            onClick={() => onResumeJob(job, 'retry_batch', idx)}
                            className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium text-slate-700 bg-slate-100 border border-slate-200 rounded-md hover:bg-slate-200 disabled:opacity-60 transition-colors whitespace-nowrap shrink-0"
                          >
                            <RotateCcw className="w-3 h-3" aria-hidden="true" />
                            <span>重跑此批次</span>
                          </button>
                        </div>
                      )}
                    </div>
                  </div>

                  {b.errorMessage && (
                    <p className="text-xs text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
                      中断详情：{b.errorMessage}
                    </p>
                  )}

                  {spec && (
                    <>
                      <p className="text-xs text-slate-600 leading-relaxed">{spec.scopeSummary}</p>
                      <div className="text-xs text-slate-500">
                        打包覆盖小节：{spec.sections.join('  /  ')}
                      </div>
                    </>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
};
