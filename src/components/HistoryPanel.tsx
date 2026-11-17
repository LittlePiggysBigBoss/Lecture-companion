import React, { useMemo, useState } from 'react';
import {
  CloudDownload,
  CloudUpload,
  Download,
  ExternalLink,
  Eye,
  FilePlus2,
  FolderCheck,
  GitBranchPlus,
  Loader2,
  Play,
  RotateCcw,
  Search,
  Trash2,
} from 'lucide-react';
import type { PipelineJob, ResumeStrategy } from '../types';
import { calculateJobProgress, isJobResumable } from '../utils/pipelineLogic';

interface HistoryPanelProps {
  jobs: PipelineJob[];
  isCompilingPdfJobId: string | null;
  isUploadingDriveJobId: string | null;
  isResumingJobId: string | null;
  isSyncingFromDrive: boolean;
  hasDriveToken: boolean;
  onSelectJob: (jobId: string) => void;
  onStartExpandFromHistory?: (job: PipelineJob) => void;
  onResumeJob: (job: PipelineJob, strategy: ResumeStrategy) => Promise<void>;
  onSyncFromDrive: () => Promise<void>;
  onDownloadPdf: (job: PipelineJob) => Promise<void>;
  onSyncToDrive: (job: PipelineJob) => Promise<void>;
  onRequestDeleteJob: (job: PipelineJob) => void;
  onGoToComposer: () => void;
}

type HistoryFilter = 'all' | 'lecture_notes' | 'workbook' | 'archived';

export const HistoryPanel: React.FC<HistoryPanelProps> = ({
  jobs,
  isCompilingPdfJobId,
  isUploadingDriveJobId,
  isResumingJobId,
  isSyncingFromDrive,
  hasDriveToken,
  onSelectJob,
  onStartExpandFromHistory,
  onResumeJob,
  onSyncFromDrive,
  onDownloadPdf,
  onSyncToDrive,
  onRequestDeleteJob,
  onGoToComposer,
}) => {
  const [filter, setFilter] = useState<HistoryFilter>('all');
  const [searchQuery, setSearchQuery] = useState('');

  const summaryStats = useMemo(() => {
    const totalDocs = jobs.length;
    const totalWords = jobs.reduce((sum, j) => sum + (j.charCount || 0), 0);
    const totalContinuations = jobs.reduce(
      (sum, j) =>
        sum + j.batches.reduce((bSum, b) => bSum + (b.continuationCount || 0), 0),
      0
    );
    const archivedCount = jobs.filter((j) => j.driveArchive.status === 'archived').length;
    return { totalDocs, totalWords, totalContinuations, archivedCount };
  }, [jobs]);

  const filteredJobs = useMemo(() => {
    return jobs.filter((job) => {
      if (filter === 'lecture_notes' && job.mode !== 'lecture_notes') return false;
      if (filter === 'workbook' && job.mode !== 'workbook') return false;
      if (filter === 'archived' && job.driveArchive.status !== 'archived') return false;

      if (searchQuery.trim()) {
        const q = searchQuery.trim().toLowerCase();
        const hay = [
          job.plan?.documentTitle || '',
          job.plan?.subjectCategory || '',
          job.plan?.courseCode || '',
          job.rawUserPrompt,
          job.driveArchive.folderPath || '',
        ]
          .join(' ')
          .toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [jobs, filter, searchQuery]);

  return (
    <div className="max-w-5xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div className="space-y-1">
          <h1 className="text-2xl font-bold text-slate-900">多终端任务同步与个人云归档面板</h1>
          <p className="text-sm text-slate-600">
            不同设备登录同一账号实时同步全部进行中与已完成任务；文件驻留您个人的 Google Cloud，仅点击下载时才保存到本地。
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2.5 shrink-0 self-start sm:self-auto">
          <button
            type="button"
            disabled={isSyncingFromDrive}
            onClick={onSyncFromDrive}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold text-slate-700 bg-white border border-slate-200 rounded-lg hover:bg-slate-50 disabled:opacity-60 transition-colors whitespace-nowrap shrink-0"
          >
            {isSyncingFromDrive ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin text-blue-600" aria-hidden="true" />
            ) : (
              <CloudDownload className="w-3.5 h-3.5 text-blue-600" aria-hidden="true" />
            )}
            <span>从 Google Drive 同步云端任务</span>
          </button>

          <button
            type="button"
            onClick={onGoToComposer}
            className="inline-flex items-center gap-2 px-4 py-2 text-xs font-semibold text-white bg-blue-600 rounded-lg hover:bg-blue-700 transition-colors whitespace-nowrap shrink-0"
          >
            <FilePlus2 className="w-4 h-4" aria-hidden="true" />
            <span>新建自动生成任务</span>
          </button>
        </div>
      </div>

      {/* Clean Single-Elevation Metric Strip */}
      <div className="bg-white border border-slate-200 rounded-xl grid grid-cols-2 lg:grid-cols-4 divide-y lg:divide-y-0 lg:divide-x divide-slate-200">
        <div className="p-4 sm:p-5 space-y-1">
          <div className="text-xs text-slate-500">累计生成学术文档</div>
          <div className="text-2xl font-bold text-slate-900 font-mono tabular-nums">
            {summaryStats.totalDocs}
          </div>
        </div>
        <div className="p-4 sm:p-5 space-y-1">
          <div className="text-xs text-slate-500">累计自动编纂字/词数</div>
          <div className="text-2xl font-bold text-slate-900 font-mono tabular-nums">
            {summaryStats.totalWords.toLocaleString()}
          </div>
        </div>
        <div className="p-4 sm:p-5 space-y-1">
          <div className="text-xs text-slate-500">零干预自动续写次数</div>
          <div className="text-2xl font-bold text-slate-900 font-mono tabular-nums">
            {summaryStats.totalContinuations}
          </div>
        </div>
        <div className="p-4 sm:p-5 space-y-1">
          <div className="text-xs text-slate-500">已归档至 Google Drive</div>
          <div className="text-2xl font-bold text-emerald-700 font-mono tabular-nums">
            {summaryStats.archivedCount}
          </div>
        </div>
      </div>

      {/* Filter Tabs + Search Input */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-3">
        <div className="inline-flex items-center gap-1 p-1 bg-slate-200/70 rounded-lg self-start" role="group" aria-label="筛选历史记录">
          {(
            [
              { key: 'all', label: '全部记录' },
              { key: 'lecture_notes', label: '课程讲义' },
              { key: 'workbook', label: '练习题册' },
              { key: 'archived', label: '已归档云端' },
            ] as const
          ).map((tab) => (
            <button
              key={tab.key}
              type="button"
              onClick={() => setFilter(tab.key)}
              className={`px-3 py-1.5 text-xs font-semibold rounded-md transition-colors whitespace-nowrap shrink-0 ${
                filter === tab.key
                  ? 'bg-white text-slate-900 shadow-xs'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>

        <div className="relative w-full md:w-72">
          <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" aria-hidden="true" />
          <label htmlFor="history-search-input" className="sr-only">
            搜索历史讲义与题册
          </label>
          <input
            id="history-search-input"
            type="search"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="搜索标题、学科分类、课程代码..."
            className="w-full pl-9 pr-3 py-2 text-xs text-slate-900 bg-white border border-slate-200 rounded-lg focus:outline-none focus:border-blue-600"
          />
        </div>
      </div>

      {/* High-Density History List */}
      {filteredJobs.length === 0 ? (
        <div className="bg-white border border-slate-200 rounded-xl p-12 text-center space-y-3">
          <p className="text-sm font-medium text-slate-800">没有符合当前筛选条件的历史记录</p>
          <p className="text-xs text-slate-500">
            尝试切换上方的分类标签、清空搜索词，或直接创建一份新的讲义 / 练习题册。
          </p>
          <button
            type="button"
            onClick={() => {
              setFilter('all');
              setSearchQuery('');
            }}
            className="inline-flex items-center px-3.5 py-1.5 text-xs font-medium text-slate-700 bg-slate-100 rounded-lg hover:bg-slate-200 transition-colors"
          >
            重置筛选条件
          </button>
        </div>
      ) : (
        <div className="bg-white border border-slate-200 rounded-xl divide-y divide-slate-200">
          {filteredJobs.map((job) => {
            const prog = calculateJobProgress({ stage: job.stage, batches: job.batches });
            const isActive =
              job.stage === 'planning' ||
              job.stage === 'executing' ||
              job.stage === 'compiling_pdf' ||
              job.stage === 'uploading_drive';
            const isCompiling = isCompilingPdfJobId === job.id;
            const isUploading = isUploadingDriveJobId === job.id;
            const isResuming = isResumingJobId === job.id;
            const canResume = !isActive && isJobResumable(job);
            const titleText = job.plan?.documentTitle || job.rawUserPrompt.slice(0, 48) || '未命名任务';

            return (
              <div
                key={job.id}
                className="p-5 hover:bg-slate-50/70 transition-colors flex flex-col lg:flex-row lg:items-center justify-between gap-4"
              >
                <div className="space-y-1.5 min-w-0 flex-1">
                  {/* Unboxed Metadata Line */}
                  <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500 font-mono tabular-nums">
                    <span>{job.plan?.courseCode || 'CARBON'}</span>
                    <span aria-hidden="true">·</span>
                    <span className="font-sans">{job.plan?.subjectCategory || '自动分类'}</span>
                    <span aria-hidden="true">·</span>
                    <span className="font-sans">
                      {job.mode === 'workbook' ? '练习题册' : '课程讲义'}
                    </span>
                    <span aria-hidden="true">·</span>
                    <span>{job.estimatedPages} 页 A4</span>
                    <span aria-hidden="true">·</span>
                    <span>{job.charCount.toLocaleString()} 字</span>
                    {job.outputVolumes && job.outputVolumes.length > 1 && (
                      <>
                        <span aria-hidden="true">·</span>
                        <span className="font-sans font-semibold text-blue-700">
                          分册输出 {job.outputVolumes.length} 份独立 PDF
                        </span>
                      </>
                    )}
                    {typeof job.expansionCount === 'number' && job.expansionCount > 0 && (
                      <>
                        <span aria-hidden="true">·</span>
                        <span className="font-sans text-emerald-700">
                          已扩编 {job.expansionCount} 次
                        </span>
                      </>
                    )}
                    {(job.parentJobId ||
                      (job.sourceContextJobIds && job.sourceContextJobIds.length > 0)) && (
                      <>
                        <span aria-hidden="true">·</span>
                        <span className="font-sans text-blue-700">长上下文记忆派生</span>
                      </>
                    )}
                    {job.scannedLinks && job.scannedLinks.length > 0 && (
                      <>
                        <span aria-hidden="true">·</span>
                        <span className="font-sans text-slate-700">
                          已解析 {job.scannedLinks.length} 处链接
                        </span>
                      </>
                    )}
                    <span aria-hidden="true">·</span>
                    <span>
                      {new Date(job.createdAt).toLocaleString('zh-CN', {
                        dateStyle: 'short',
                        timeStyle: 'short',
                      })}
                    </span>
                  </div>

                  <button
                    type="button"
                    onClick={() => onSelectJob(job.id)}
                    className="text-left text-base font-semibold text-slate-900 hover:text-blue-700 transition-colors block truncate max-w-full"
                  >
                    {titleText}
                  </button>

                  {/* Status + Drive Folder Line */}
                  <div className="flex flex-wrap items-center gap-2 text-xs text-slate-600">
                    {isActive ? (
                      <span className="inline-flex items-center gap-1.5 text-blue-700 font-medium font-mono tabular-nums">
                        <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" />
                        云端后台执行中 ({prog.percent}%)
                      </span>
                    ) : job.stage === 'completed' ? (
                      <span className="text-emerald-700 font-medium">已完成生成</span>
                    ) : job.stage === 'error' ? (
                      <span className="text-red-600 font-medium">
                        步骤中断（已完成 {prog.completedBatches}/{prog.totalBatches || 1} 批，可断点续跑）
                      </span>
                    ) : (
                      <span className="text-amber-700 font-medium">
                        已暂停（已完成 {prog.completedBatches}/{prog.totalBatches || 1} 批，可继续生成）
                      </span>
                    )}

                    {job.driveArchive.folderPath && (
                      <>
                        <span aria-hidden="true">·</span>
                        <span className="inline-flex items-center gap-1 text-slate-500 truncate max-w-md">
                          <FolderCheck className="w-3.5 h-3.5 shrink-0 text-slate-400" aria-hidden="true" />
                          <span className="font-mono truncate">{job.driveArchive.folderPath}</span>
                        </span>
                      </>
                    )}
                  </div>

                  {(job.stage === 'error' || job.stage === 'cancelled') && job.errorMessage && (
                    <p className="text-xs text-red-600 line-clamp-1">
                      原因：{job.errorMessage}
                    </p>
                  )}
                </div>

                {/* Row Actions */}
                <div className="flex flex-wrap items-center gap-2 shrink-0">
                  {canResume && (
                    <>
                      <button
                        type="button"
                        disabled={isResuming}
                        onClick={() => onResumeJob(job, 'continue')}
                        aria-label={`断点继续生成「${titleText}」`}
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-white bg-blue-600 rounded-lg hover:bg-blue-700 disabled:opacity-60 transition-colors whitespace-nowrap shrink-0"
                      >
                        {isResuming ? (
                          <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" />
                        ) : (
                          <Play className="w-3.5 h-3.5 fill-current" aria-hidden="true" />
                        )}
                        <span>断点继续生成</span>
                      </button>

                      <button
                        type="button"
                        disabled={isResuming}
                        onClick={() => onResumeJob(job, 'retry_batch')}
                        aria-label={`重跑「${titleText}」失败步骤`}
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-700 bg-white border border-slate-200 rounded-lg hover:bg-slate-100 disabled:opacity-60 transition-colors whitespace-nowrap shrink-0"
                      >
                        <RotateCcw className="w-3.5 h-3.5 text-slate-600" aria-hidden="true" />
                        <span>重跑失败步骤</span>
                      </button>
                    </>
                  )}

                  {job.driveArchive.status === 'archived' && job.driveArchive.webViewLink && (
                    <a
                      href={job.driveArchive.webViewLink}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-lg hover:bg-emerald-100 transition-colors whitespace-nowrap shrink-0"
                    >
                      <ExternalLink className="w-3.5 h-3.5" aria-hidden="true" />
                      <span>在 Drive 预览 PDF</span>
                    </a>
                  )}

                  {!isActive &&
                    job.stage === 'completed' &&
                    onStartExpandFromHistory && (
                      <button
                        type="button"
                        onClick={() => onStartExpandFromHistory(job)}
                        aria-label={`基于「${titleText}」继续扩展或派生新任务`}
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-blue-700 bg-blue-50 border border-blue-200 rounded-lg hover:bg-blue-100 transition-colors whitespace-nowrap shrink-0"
                      >
                        <GitBranchPlus className="w-3.5 h-3.5" aria-hidden="true" />
                        <span>继续扩展 / 派生</span>
                      </button>
                    )}

                  <button
                    type="button"
                    onClick={() => onSelectJob(job.id)}
                    aria-label={`查看「${titleText}」排版详情`}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-700 bg-white border border-slate-200 rounded-lg hover:bg-slate-100 transition-colors whitespace-nowrap shrink-0"
                  >
                    <Eye className="w-3.5 h-3.5" aria-hidden="true" />
                    <span>预览与批次</span>
                  </button>

                  <button
                    type="button"
                    disabled={!job.compiledMarkdown || isCompiling || isActive}
                    onClick={() => onDownloadPdf(job)}
                    aria-label={`下载「${titleText}」PDF`}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-800 bg-white border border-slate-200 rounded-lg hover:bg-slate-100 disabled:opacity-50 transition-colors whitespace-nowrap shrink-0"
                  >
                    {isCompiling ? (
                      <Loader2 className="w-3.5 h-3.5 animate-spin text-blue-600" aria-hidden="true" />
                    ) : (
                      <Download className="w-3.5 h-3.5 text-blue-600" aria-hidden="true" />
                    )}
                    <span>下载 PDF</span>
                  </button>

                  {!(job.driveArchive.status === 'archived' && job.driveArchive.webViewLink) && (
                    <button
                      type="button"
                      disabled={!job.compiledMarkdown || isUploading || isActive}
                      onClick={() => onSyncToDrive(job)}
                      aria-label={`归档「${titleText}」至 Google Drive`}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-700 bg-white border border-slate-200 rounded-lg hover:bg-slate-100 disabled:opacity-50 transition-colors whitespace-nowrap shrink-0"
                    >
                      {isUploading ? (
                        <Loader2 className="w-3.5 h-3.5 animate-spin text-blue-600" aria-hidden="true" />
                      ) : (
                        <CloudUpload className="w-3.5 h-3.5 text-slate-500" aria-hidden="true" />
                      )}
                      <span>{hasDriveToken ? '优先存入 Drive' : '登录并存 Drive'}</span>
                    </button>
                  )}

                  <button
                    type="button"
                    onClick={() => onRequestDeleteJob(job)}
                    aria-label={`删除记录「${titleText}」`}
                    className="p-1.5 text-slate-400 hover:text-red-600 hover:bg-red-50 rounded-lg transition-colors shrink-0"
                  >
                    <Trash2 className="w-4 h-4" aria-hidden="true" />
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};
