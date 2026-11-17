import React, { useMemo, useRef, useState } from 'react';
import {
  BookCopy,
  BookOpen,
  BrainCircuit,
  ClipboardCheck,
  Coins,
  FileSpreadsheet,
  FileText,
  FolderGit2,
  Image as ImageIcon,
  Loader2,
  Paperclip,
  Play,
  Sparkles,
  Upload,
  X,
} from 'lucide-react';
import type {
  DepthPreset,
  DocMode,
  PipelineJob,
  PricingConfig,
  ScannedLinkResult,
  UploadedAttachment,
  UserAccountProfile,
  VolumeSplitMode,
} from '../types';
import { STARTER_TEMPLATES } from '../data/seedHistory';
import type { UploadProgressState } from '../services/fileAndVoiceClient';
import { formatFileSize } from '../services/fileAndVoiceClient';
import {
  detectMultiVolumeIntent,
  SINGLE_CALL_TARGET_WORDS_BY_DEPTH,
} from '../utils/adaptiveWorkflowLogic';
import {
  DEFAULT_PRICING_CONFIG,
  estimateTaskTokenAndPrice,
} from '../utils/billingAndQuota';
import { buildDriveArchivePath } from '../utils/pipelineLogic';
import { LinkRecognitionBar } from './LinkRecognitionBar';
import { VoiceDictationButton } from './VoiceDictationButton';

interface ComposerPanelProps {
  mode: DocMode;
  onModeChange: (mode: DocMode) => void;
  depth: DepthPreset;
  onDepthChange: (depth: DepthPreset) => void;
  volumeSplitMode: VolumeSplitMode;
  onVolumeSplitModeChange: (mode: VolumeSplitMode) => void;
  prompt: string;
  onPromptChange: (val: string) => void;
  attachments: UploadedAttachment[];
  onAddAttachments: (files: FileList | File[]) => Promise<void>;
  onIngestScannedAttachments: (items: UploadedAttachment[]) => void;
  onScannedLinksChange?: (links: ScannedLinkResult[]) => void;
  onRemoveAttachment: (id: string) => void;
  uploadProgress?: UploadProgressState | null;
  availableHistoricalJobs: PipelineJob[];
  sourceContextJobIds: string[];
  onToggleSourceContextJobId: (jobId: string) => void;
  onClearSourceContextJobs: () => void;
  enableHistoricalMemory: boolean;
  onEnableHistoricalMemoryChange: (val: boolean) => void;
  driveToken?: string | null;
  autoArchiveDrive: boolean;
  onAutoArchiveDriveChange: (val: boolean) => void;
  customRootFolder: string;
  onCustomRootFolderChange: (val: string) => void;
  hasDriveToken: boolean;
  accountProfile: UserAccountProfile | null;
  pricingConfig: PricingConfig;
  isSigningIn?: boolean;
  onRequestGoogleSignIn?: () => void;
  onOpenBillingTab?: () => void;
  onVoiceError?: (msg: string) => void;
  isParsingFiles: boolean;
  isRunningPipeline: boolean;
  validationError: string | null;
  onSubmitPipeline: (e: React.FormEvent) => void;
}

export const ComposerPanel: React.FC<ComposerPanelProps> = ({
  mode,
  onModeChange,
  depth,
  onDepthChange,
  volumeSplitMode,
  onVolumeSplitModeChange,
  prompt,
  onPromptChange,
  attachments,
  onAddAttachments,
  onIngestScannedAttachments,
  onScannedLinksChange,
  onRemoveAttachment,
  uploadProgress = null,
  availableHistoricalJobs,
  sourceContextJobIds,
  onToggleSourceContextJobId,
  onClearSourceContextJobs,
  enableHistoricalMemory,
  onEnableHistoricalMemoryChange,
  driveToken,
  autoArchiveDrive,
  onAutoArchiveDriveChange,
  customRootFolder,
  onCustomRootFolderChange,
  hasDriveToken,
  accountProfile,
  pricingConfig = DEFAULT_PRICING_CONFIG,
  isSigningIn = false,
  onRequestGoogleSignIn,
  onOpenBillingTab,
  onVoiceError,
  isParsingFiles,
  isRunningPipeline,
  validationError,
  onSubmitPipeline,
}) => {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [isDragging, setIsDragging] = useState(false);

  const previewDrivePath = buildDriveArchivePath({
    rootFolder: customRootFolder,
    subjectCategory: '[自动识别学科]',
    mode,
  });

  const liveCostEstimate = useMemo(
    () =>
      estimateTaskTokenAndPrice({
        mode,
        depth,
        promptLength: prompt.length,
        attachments: attachments.map((a) => ({ kind: a.kind, size: a.size })),
        pricing: pricingConfig,
      }),
    [mode, depth, prompt.length, attachments, pricingConfig]
  );

  const liveMultiVolumeDetection = useMemo(
    () =>
      detectMultiVolumeIntent({
        rawPrompt: prompt,
        explicitMode: volumeSplitMode,
      }),
    [prompt, volumeSplitMode]
  );

  const singleCallWordsTarget = SINGLE_CALL_TARGET_WORDS_BY_DEPTH[depth];

  const handlePaste = async (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    const pastedFiles: File[] = [];
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (item.kind === 'file') {
        const file = item.getAsFile();
        if (file) pastedFiles.push(file);
      }
    }
    if (pastedFiles.length > 0) {
      await onAddAttachments(pastedFiles);
    }
  };

  const handleDrop = async (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setIsDragging(false);
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      await onAddAttachments(e.dataTransfer.files);
    }
  };

  return (
    <div className="max-w-4xl mx-auto space-y-8">
      {/* Header Intro */}
      <div className="space-y-2">
        <h1
          className="text-2xl sm:text-3xl font-bold tracking-tight text-slate-900"
          style={{ textWrap: 'balance' }}
        >
          全自动学术讲义与练习题册生成工坊
        </h1>
        <p className="text-sm sm:text-base text-slate-600 leading-relaxed max-w-3xl">
          内置调用 Gemini 4 Carbon 深度推理与百万级长上下文记忆引擎。自动识别分册需求并输出多份独立 PDF 文件，充分利用模型单次调用输出极限，不设固定轮次上限——按内容真实体量需要多少轮自动拆分成多少轮。
        </p>
      </div>

      <form onSubmit={onSubmitPipeline} className="space-y-6">
        {/* Step 1: Document Mode + Depth Controls */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="bg-white border border-slate-200 rounded-xl p-4 space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold text-slate-700">1. 选择生成文档形态</span>
              <span className="text-xs text-slate-500">自动匹配学术排版体例</span>
            </div>
            <div
              className="grid grid-cols-2 gap-1.5 p-1 bg-slate-100 rounded-lg"
              role="group"
              aria-label="生成文档形态"
            >
              <button
                type="button"
                onClick={() => onModeChange('lecture_notes')}
                className={`flex items-center justify-center gap-2 py-2 px-3 text-xs font-semibold rounded-md transition-colors whitespace-nowrap shrink-0 ${
                  mode === 'lecture_notes'
                    ? 'bg-white text-slate-900 shadow-xs'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                <BookOpen className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
                <span>课程讲义 PDF</span>
              </button>
              <button
                type="button"
                onClick={() => onModeChange('workbook')}
                className={`flex items-center justify-center gap-2 py-2 px-3 text-xs font-semibold rounded-md transition-colors whitespace-nowrap shrink-0 ${
                  mode === 'workbook'
                    ? 'bg-white text-slate-900 shadow-xs'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                <ClipboardCheck className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
                <span>练习题册 PDF</span>
              </button>
            </div>
            <p className="text-xs text-slate-500 leading-relaxed">
              {mode === 'lecture_notes'
                ? '包含背景动机、严密定义、定理分步证明、几何/物理直觉、典型例题完整演算与章节小结。'
                : '按基础巩固、进阶计算、综合压轴分级命题，每道题均自动附带完整分步推导与评分标准。'}
            </p>
          </div>

          <div className="bg-white border border-slate-200 rounded-xl p-4 space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold text-slate-700">
                2. 单次调用极限密度与自适应轮次
              </span>
              <span className="text-xs text-slate-500 font-mono tabular-nums">
                ~{singleCallWordsTarget.toLocaleString()} 字/轮 · 轮次无上限
              </span>
            </div>
            <div
              className="grid grid-cols-3 gap-1 p-1 bg-slate-100 rounded-lg"
              role="group"
              aria-label="生成深度档位"
            >
              {(
                [
                  { key: 'standard', label: '标准精编' },
                  { key: 'comprehensive', label: '深度详尽' },
                  { key: 'exhaustive', label: '全书穷尽' },
                ] as const
              ).map((item) => (
                <button
                  key={item.key}
                  type="button"
                  onClick={() => onDepthChange(item.key)}
                  className={`py-2 px-2.5 text-xs font-semibold rounded-md transition-colors whitespace-nowrap shrink-0 ${
                    depth === item.key
                      ? 'bg-white text-slate-900 shadow-xs'
                      : 'text-slate-600 hover:text-slate-900'
                  }`}
                >
                  {item.label}
                </button>
              ))}
            </div>
            <p className="text-xs text-slate-500 leading-relaxed">
              {depth === 'standard' &&
                '每轮压榨单次调用输出极限（约 8,500 字/轮），不设固定轮次上限，按章节真实体量自动拆分为 1..N 轮直出。'}
              {depth === 'comprehensive' &&
                '开启 Carbon High 深度推理，每轮满载输出约 11,500 字，不固定轮次，需要多少轮自动拆分成多少轮直至推导完备。'}
              {depth === 'exhaustive' &&
                '教材/竞赛全书级密度，每轮极限满载约 14,000 字，零人工干预动态排程任意所需轮次并开启截断自动续写。'}
            </p>
          </div>
        </div>

        {/* Step 1.5: Automatic Multi-Volume / Multi-File Output Strategy */}
        <div className="bg-white border border-slate-200 rounded-xl p-4 space-y-3">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <BookCopy className="w-4 h-4 text-blue-600 shrink-0" aria-hidden="true" />
              <span className="text-xs font-semibold text-slate-900">
                3. 文件输出与自动分册策略（支持按章节分册 · 正文与答案解析拆分为多份独立 PDF）
              </span>
            </div>
            <div
              className="inline-flex items-center gap-1 p-1 bg-slate-100 rounded-lg self-start sm:self-auto"
              role="group"
              aria-label="文件分册输出策略"
            >
              {(
                [
                  { key: 'auto', label: '自动识别是否分册' },
                  { key: 'multi_volume', label: '多份独立分册文件' },
                  { key: 'single_file', label: '合并单份 PDF' },
                ] as const
              ).map((opt) => (
                <button
                  key={opt.key}
                  type="button"
                  onClick={() => onVolumeSplitModeChange(opt.key)}
                  className={`py-1.5 px-2.5 text-xs font-semibold rounded-md transition-colors whitespace-nowrap shrink-0 ${
                    volumeSplitMode === opt.key
                      ? 'bg-white text-slate-900 shadow-xs'
                      : 'text-slate-600 hover:text-slate-900'
                  }`}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </div>

          <div
            className={`flex items-start gap-2 text-xs rounded-lg px-3 py-2 border ${
              liveMultiVolumeDetection.shouldSplitVolumes
                ? 'bg-blue-50/70 border-blue-200 text-blue-900'
                : 'bg-slate-50 border-slate-200 text-slate-600'
            }`}
          >
            <Sparkles
              className={`w-3.5 h-3.5 mt-0.5 shrink-0 ${
                liveMultiVolumeDetection.shouldSplitVolumes ? 'text-blue-600' : 'text-slate-400'
              }`}
              aria-hidden="true"
            />
            <span className="leading-relaxed">{liveMultiVolumeDetection.reasonSummary}</span>
          </div>
        </div>

        {/* Step 2: Gemini-Style Multimodal Input Composer + Unlimited File Upload + Voice Dictation */}
        <div
          onDragOver={(e) => {
            e.preventDefault();
            setIsDragging(true);
          }}
          onDragLeave={() => setIsDragging(false)}
          onDrop={handleDrop}
          className={`bg-white border rounded-xl transition-colors ${
            isDragging
              ? 'border-blue-600 bg-blue-50/30'
              : validationError
                ? 'border-red-400'
                : 'border-slate-200 focus-within:border-slate-400'
          }`}
        >
          {/* Attachment Chips Tray + Chunked Upload Progress */}
          {(attachments.length > 0 || isParsingFiles || uploadProgress) && (
            <div className="px-4 pt-4 pb-2 flex flex-wrap gap-2.5 border-b border-slate-100">
              {attachments.map((att) => (
                <div
                  key={att.id}
                  className="flex items-center gap-2.5 pl-2.5 pr-2 py-1.5 bg-slate-50 border border-slate-200 rounded-lg max-w-[260px]"
                >
                  {att.kind === 'image' && att.previewUrl ? (
                    <img
                      src={att.previewUrl}
                      alt={att.name}
                      referrerPolicy="no-referrer"
                      className="w-8 h-8 rounded object-cover border border-slate-200 shrink-0"
                    />
                  ) : att.kind === 'pdf' ? (
                    <div className="w-8 h-8 rounded bg-red-50 text-red-600 flex items-center justify-center shrink-0">
                      <FileText className="w-4 h-4" aria-hidden="true" />
                    </div>
                  ) : att.kind === 'docx' ? (
                    <div className="w-8 h-8 rounded bg-blue-50 text-blue-600 flex items-center justify-center shrink-0">
                      <FileSpreadsheet className="w-4 h-4" aria-hidden="true" />
                    </div>
                  ) : (
                    <div className="w-8 h-8 rounded bg-slate-200/70 text-slate-700 flex items-center justify-center shrink-0">
                      <ImageIcon className="w-4 h-4" aria-hidden="true" />
                    </div>
                  )}
                  <div className="min-w-0 flex-1">
                    <p className="text-xs font-medium text-slate-800 truncate">{att.name}</p>
                    <p className="text-[11px] text-slate-500 font-mono tabular-nums">
                      {att.kind.toUpperCase()} · {formatFileSize(att.size)}
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => onRemoveAttachment(att.id)}
                    aria-label={`移除附件 ${att.name}`}
                    className="p-1 text-slate-400 hover:text-slate-700 rounded transition-colors shrink-0"
                  >
                    <X className="w-3.5 h-3.5" aria-hidden="true" />
                  </button>
                </div>
              ))}

              {uploadProgress ? (
                <div className="flex items-center gap-2 px-3 py-2 text-xs text-blue-800 bg-blue-50 border border-blue-200 rounded-lg">
                  <Loader2 className="w-3.5 h-3.5 animate-spin text-blue-600" aria-hidden="true" />
                  <span className="truncate max-w-[180px]">{uploadProgress.fileName}</span>
                  <span className="font-mono tabular-nums font-semibold">
                    {uploadProgress.percent}% ({formatFileSize(uploadProgress.uploadedBytes)} /{' '}
                    {formatFileSize(uploadProgress.totalBytes)})
                  </span>
                </div>
              ) : (
                isParsingFiles && (
                  <div className="flex items-center gap-2 px-3 py-2 text-xs text-slate-600 bg-slate-50 border border-slate-200 rounded-lg">
                    <Loader2 className="w-3.5 h-3.5 animate-spin text-blue-600" aria-hidden="true" />
                    <span>正在流式上传与解析文件...</span>
                  </div>
                )
              )}
            </div>
          )}

          <div className="p-4">
            <label htmlFor="carbon-prompt-input" className="sr-only">
              输入讲义或练习题册主题要求
            </label>
            <textarea
              id="carbon-prompt-input"
              rows={5}
              value={prompt}
              onChange={(e) => onPromptChange(e.target.value)}
              onPaste={handlePaste}
              placeholder={
                mode === 'lecture_notes'
                  ? '输入讲义要求，或直接粘贴 Google Drive 文件/文件夹链接、Google Docs、arXiv、PDF 网页链接（自动识别抓取并多模态扫描），支持语音口述与拖拽不限大小文件...'
                  : '输入练习题册考察范围，或粘贴 Google Drive 真题链接 / 网页大纲链接（自动识别抓取），也可在下方面板勾选已完成讲义做长上下文配套命题...'
              }
              className="w-full resize-y text-sm sm:text-[15px] text-slate-900 placeholder:text-slate-400 bg-transparent focus:outline-none leading-relaxed"
            />
          </div>

          <LinkRecognitionBar
            text={prompt}
            driveToken={driveToken}
            onIngestedAttachments={onIngestScannedAttachments}
            onScannedLinksChange={onScannedLinksChange}
          />

          {/* Bottom Composer Action Bar */}
          <div className="px-4 py-3 bg-slate-50/70 border-t border-slate-200 rounded-b-xl flex flex-wrap items-center justify-between gap-3">
            <div className="flex flex-wrap items-center gap-2">
              <input
                ref={fileInputRef}
                type="file"
                multiple
                onChange={async (e) => {
                  if (e.target.files && e.target.files.length > 0) {
                    await onAddAttachments(e.target.files);
                    e.target.value = '';
                  }
                }}
                className="hidden"
                id="multimodal-file-upload"
              />
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                disabled={isParsingFiles || isRunningPipeline}
                className="inline-flex items-center gap-2 px-3.5 py-2 text-xs font-medium text-slate-700 bg-white border border-slate-200 rounded-lg hover:bg-slate-100 disabled:opacity-50 transition-colors whitespace-nowrap shrink-0"
              >
                <Paperclip className="w-3.5 h-3.5 text-slate-500" aria-hidden="true" />
                <span>上传文件（不限大小）</span>
              </button>

              <VoiceDictationButton
                disabled={isParsingFiles || isRunningPipeline}
                label="语音录入需求"
                onTranscribed={(spoken) => {
                  onPromptChange(prompt.trim() ? `${prompt.trim()} ${spoken}` : spoken);
                }}
                onError={onVoiceError}
              />

              <span className="text-xs text-slate-500 hidden xl:inline">
                分片流式直传，支持 GB 级 PDF 教材、高清图集、DOCX 与音频
              </span>
            </div>

            <button
              type="submit"
              disabled={isRunningPipeline || isParsingFiles}
              className="inline-flex items-center gap-2 px-5 py-2.5 text-xs sm:text-sm font-semibold text-white bg-blue-600 rounded-lg hover:bg-blue-700 disabled:opacity-60 transition-colors whitespace-nowrap shrink-0"
            >
              {isRunningPipeline ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" />
                  <span>正在挂载至云端后台...</span>
                </>
              ) : (
                <>
                  <Play className="w-4 h-4 fill-current" aria-hidden="true" />
                  <span>启动全自动生成与云端托管</span>
                </>
              )}
            </button>
          </div>
        </div>

        {validationError && (
          <p role="alert" className="text-xs font-medium text-red-600">
            {validationError}
          </p>
        )}

        {/* Step 2.5: Strong Historical Memory & Long-Context Reference Binding Panel */}
        <div className="bg-white border border-slate-200 rounded-xl p-4 space-y-3">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
            <div className="flex items-center gap-2.5">
              <BrainCircuit className="w-4 h-4 text-blue-600 shrink-0" aria-hidden="true" />
              <label
                htmlFor="historical-memory-toggle"
                className="text-xs font-semibold text-slate-900 cursor-pointer"
              >
                强历史记忆与超长上下文理解引擎（跨任务符号体系一致 · 支持绑定已完成讲义/题册深层续写）
              </label>
            </div>
            <div className="flex items-center gap-3 shrink-0">
              {sourceContextJobIds.length > 0 && (
                <button
                  type="button"
                  onClick={onClearSourceContextJobs}
                  className="text-xs text-blue-700 hover:underline whitespace-nowrap"
                >
                  清空已选基准 ({sourceContextJobIds.length})
                </button>
              )}
              <label className="inline-flex items-center gap-1.5 text-xs text-slate-600 cursor-pointer whitespace-nowrap">
                <input
                  id="historical-memory-toggle"
                  type="checkbox"
                  checked={enableHistoricalMemory}
                  onChange={(e) => onEnableHistoricalMemoryChange(e.target.checked)}
                  className="w-4 h-4 rounded border-slate-300 text-blue-600 focus:ring-blue-500 cursor-pointer"
                />
                <span>启用全局历史记忆</span>
              </label>
            </div>
          </div>

          <p className="text-xs text-slate-500 leading-relaxed">
            开启后，模型自动读取您历史任务的学科偏好、LaTeX 记号与章节脉络；勾选下方已完成或大容量文档后，系统将把其全量正文与定理/题号总账注入长上下文，实现配套题册或续篇讲义的无缝扩展。
          </p>

          {availableHistoricalJobs.length > 0 && (
            <div className="space-y-1.5 pt-1">
              <div className="text-xs font-medium text-slate-700">
                可选：勾选作为本次任务长上下文基准的已有文档（已选 {sourceContextJobIds.length} 份）：
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-2 max-h-40 overflow-y-auto pr-1">
                {availableHistoricalJobs.slice(0, 8).map((hj) => {
                  const checked = sourceContextJobIds.includes(hj.id);
                  const hjTitle =
                    hj.plan?.documentTitle || hj.rawUserPrompt.slice(0, 36) || '未命名文档';
                  return (
                    <label
                      key={hj.id}
                      className={`flex items-start gap-2.5 px-3 py-2 rounded-lg border text-xs cursor-pointer transition-colors ${
                        checked
                          ? 'bg-blue-50/70 border-blue-300 text-slate-900'
                          : 'bg-slate-50/60 border-slate-200 text-slate-700 hover:bg-slate-100/70'
                      }`}
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => onToggleSourceContextJobId(hj.id)}
                        className="mt-0.5 w-3.5 h-3.5 rounded border-slate-300 text-blue-600 focus:ring-blue-500 shrink-0"
                      />
                      <div className="min-w-0 flex-1">
                        <div className="font-semibold truncate">{hjTitle}</div>
                        <div className="text-[11px] text-slate-500 font-mono tabular-nums">
                          {hj.mode === 'workbook' ? '题册' : '讲义'} ·{' '}
                          {hj.charCount.toLocaleString()} 字 · {hj.estimatedPages} 页 A4
                        </div>
                      </div>
                    </label>
                  );
                })}
              </div>
            </div>
          )}
        </div>

        {/* Step 3: Real-Time Per-Page Token Cost & Quota Settlement Bar */}
        <div className="bg-white border border-slate-200 rounded-xl p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div className="flex items-start gap-2.5 min-w-0">
            <Coins className="w-4 h-4 text-blue-600 mt-0.5 shrink-0" aria-hidden="true" />
            <div className="space-y-0.5 text-xs">
              <div className="font-semibold text-slate-900 font-mono tabular-nums">
                预估约 {liveCostEstimate.estimatedPages} 页 A4 ·{' '}
                {(liveCostEstimate.estimatedTotalTokens / 1000).toFixed(1)}k Tokens · 按页单价 ¥
                {liveCostEstimate.perPagePriceCny.toFixed(2)}/页
              </div>
              <div className="text-slate-500">
                {accountProfile?.isSuperAdmin ? (
                  <span className="text-emerald-700 font-medium">
                    当前账号为超级管理员（永久免收费用 · 不受 6 小时与周配额限制）
                  </span>
                ) : accountProfile?.subscriptionActive ? (
                  <span className="text-emerald-700 font-medium">
                    已启用 ¥{pricingConfig.monthlyPriceCny}/月 包月会员配额（6h 窗口剩余{' '}
                    {Math.max(
                      0,
                      pricingConfig.sixHourTokenLimit - accountProfile.usage.sixHourTokensUsed
                    ).toLocaleString()}{' '}
                    Tokens）
                  </span>
                ) : (
                  <span>
                    新用户按页单次价（50% 毛利标准）：
                    <span className="font-mono font-semibold text-slate-900">
                      {' '}
                      ¥{liveCostEstimate.payPerPdfPriceCny.toFixed(2)}
                    </span>{' '}
                    · 或开通{' '}
                    <span className="font-mono font-semibold text-blue-700">
                      ¥{pricingConfig.monthlyPriceCny}/月
                    </span>{' '}
                    包月会员
                  </span>
                )}
              </div>
            </div>
          </div>

          {onOpenBillingTab && (
            <button
              type="button"
              onClick={onOpenBillingTab}
              className="px-3 py-1.5 text-xs font-semibold text-slate-700 bg-slate-100 border border-slate-200 rounded-lg hover:bg-slate-200 transition-colors whitespace-nowrap shrink-0 self-start sm:self-center"
            >
              计费标准与专属云配置
            </button>
          )}
        </div>

        {/* Step 4: Per-User Personal Google Cloud Hosting Bar */}
        <div className="bg-white border border-slate-200 rounded-xl p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div className="space-y-1.5 min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2.5">
              <FolderGit2 className="w-4 h-4 text-blue-600 shrink-0" aria-hidden="true" />
              <label
                htmlFor="auto-archive-toggle"
                className="text-xs font-semibold text-slate-800 cursor-pointer"
              >
                个人专属 Google Cloud 离线托管 · 多端实时同步 · 仅点击下载时拉取至本地
              </label>
            </div>
            <p className="text-xs text-slate-500 leading-relaxed">
              个人云目录：<span className="font-mono text-slate-700">{previewDrivePath.fullPath}</span>
              {hasDriveToken ? (
                <span className="text-emerald-700 font-medium">
                  {' '}
                  · 已挂载您本人的 Google Cloud，关机或断网不影响执行
                </span>
              ) : (
                <span className="text-amber-700">
                  {' '}
                  · 登录账号后自动绑定您的个人 Google Cloud 并开启多终端同步
                </span>
              )}
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-3 shrink-0">
            {!hasDriveToken && onRequestGoogleSignIn && (
              <button
                type="button"
                disabled={isSigningIn}
                onClick={onRequestGoogleSignIn}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-blue-700 bg-blue-50 border border-blue-200 rounded-lg hover:bg-blue-100 disabled:opacity-60 transition-colors whitespace-nowrap shrink-0"
              >
                {isSigningIn ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" />
                ) : (
                  <FolderGit2 className="w-3.5 h-3.5" aria-hidden="true" />
                )}
                <span>连接个人 Google Cloud</span>
              </button>
            )}

            <div className="flex items-center gap-2">
              <label
                htmlFor="drive-root-folder-input"
                className="text-xs text-slate-500 whitespace-nowrap"
              >
                总归档夹:
              </label>
              <input
                id="drive-root-folder-input"
                type="text"
                value={customRootFolder}
                onChange={(e) => onCustomRootFolderChange(e.target.value)}
                placeholder="Carbon 学术归档"
                className="w-36 px-2.5 py-1.5 text-xs text-slate-800 bg-slate-50 border border-slate-200 rounded-lg focus:outline-none focus:border-blue-600"
              />
            </div>

            <input
              id="auto-archive-toggle"
              type="checkbox"
              checked={autoArchiveDrive}
              onChange={(e) => onAutoArchiveDriveChange(e.target.checked)}
              className="w-4 h-4 rounded border-slate-300 text-blue-600 focus:ring-blue-500 cursor-pointer"
            />
          </div>
        </div>
      </form>

      {/* Quick Academic Starter Prompts */}
      <div className="space-y-3 pt-2 border-t border-slate-200">
        <div className="flex items-center justify-between">
          <h2 className="text-xs font-semibold text-slate-700">
            快速填充典型学术指令示例（演示简短输入如何自动扩展）
          </h2>
          <span className="text-xs text-slate-500">点击即可载入输入框</span>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {STARTER_TEMPLATES.map((tpl) => (
            <button
              key={tpl.id}
              type="button"
              onClick={() => {
                onModeChange(tpl.mode);
                onVolumeSplitModeChange('auto');
                onPromptChange(tpl.prompt);
              }}
              className="text-left p-3.5 bg-white border border-slate-200 rounded-xl hover:border-slate-300 hover:bg-slate-50/60 transition-colors space-y-1.5"
            >
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs font-semibold text-slate-900 truncate">{tpl.label}</span>
                <Upload
                  className="w-3.5 h-3.5 text-slate-400 shrink-0 rotate-90"
                  aria-hidden="true"
                />
              </div>
              <p className="text-xs text-slate-500 line-clamp-2 leading-relaxed">{tpl.prompt}</p>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
};
