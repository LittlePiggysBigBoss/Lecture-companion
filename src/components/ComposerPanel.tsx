import React, { useMemo, useRef, useState } from 'react';
import {
  ArrowUpRight,
  BookOpen,
  BrainCircuit,
  ChevronDown,
  ChevronUp,
  ClipboardCheck,
  Coins,
  Cpu,
  FileSpreadsheet,
  FileText,
  FolderGit2,
  Image as ImageIcon,
  Loader2,
  Paperclip,
  Play,
  SlidersHorizontal,
  X,
} from 'lucide-react';
import type {
  ColorPaletteTheme,
  DepthPreset,
  DocMode,
  PageOrientationMode,
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
import { detectResolvedPageOrientation } from '../utils/pdfServerHelpers';
import {
  COLOR_PALETTE_THEMES,
  DOCUMENT_TOOL_MODEL_REGISTRY,
} from '../utils/modelRegistryAndRouter';
import {
  DEFAULT_PRICING_CONFIG,
  estimateTaskTokenAndPrice,
} from '../utils/billingAndQuota';
import { buildDriveArchivePath } from '../utils/pipelineLogic';
import { LinkRecognitionBar } from './LinkRecognitionBar';
import { VoiceDictationButton } from './VoiceDictationButton';

const THEME_SWATCH_STYLES: Record<
  ColorPaletteTheme,
  { swatchBg: string; shortLabel: string; activeRing: string }
> = {
  academic_blue: {
    swatchBg: 'bg-blue-700',
    shortLabel: '学术蓝',
    activeRing: 'border-blue-500 bg-blue-50/80 text-blue-900 font-semibold',
  },
  emerald_science: {
    swatchBg: 'bg-emerald-700',
    shortLabel: '自然翠绿',
    activeRing: 'border-emerald-500 bg-emerald-50/80 text-emerald-900 font-semibold',
  },
  amber_olympiad: {
    swatchBg: 'bg-amber-600',
    shortLabel: '竞赛鎏金',
    activeRing: 'border-amber-500 bg-amber-50/80 text-amber-950 font-semibold',
  },
  burgundy_editorial: {
    swatchBg: 'bg-rose-800',
    shortLabel: '人文酒红',
    activeRing: 'border-rose-500 bg-rose-50/80 text-rose-950 font-semibold',
  },
};

interface ComposerPanelProps {
  mode: DocMode;
  onModeChange: (mode: DocMode) => void;
  depth: DepthPreset;
  onDepthChange: (depth: DepthPreset) => void;
  volumeSplitMode: VolumeSplitMode;
  onVolumeSplitModeChange: (mode: VolumeSplitMode) => void;
  pageOrientation?: PageOrientationMode;
  onPageOrientationChange?: (mode: PageOrientationMode) => void;
  colorTheme: ColorPaletteTheme;
  onColorThemeChange: (theme: ColorPaletteTheme) => void;
  autoGenerateFigures: boolean;
  onAutoGenerateFiguresChange: (val: boolean) => void;
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
  pageOrientation = 'auto',
  onPageOrientationChange,
  colorTheme,
  onColorThemeChange,
  autoGenerateFigures,
  onAutoGenerateFiguresChange,
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
  const [showAdvancedPanel, setShowAdvancedPanel] = useState(false);
  const [showModelRegistry, setShowModelRegistry] = useState(false);

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

  const resolvedOrientation = useMemo(
    () =>
      detectResolvedPageOrientation({
        explicitOrientation: pageOrientation,
        rawPrompt: prompt,
      }),
    [pageOrientation, prompt]
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
    <div className="max-w-4xl mx-auto space-y-7 pt-2 sm:pt-4">
      {/* Editorial Studio Header */}
      <div className="space-y-2">
        <h1 className="text-2xl sm:text-3xl font-bold tracking-tight text-slate-900 text-balance">
          深度学术讲义与练习题册生成工作台
        </h1>
        <p className="text-sm sm:text-[15px] text-slate-600 leading-relaxed max-w-3xl">
          直接输入课题要求、粘贴云盘或网页链接、或拖入任意体积参考资料。系统将在云端全自动完成总纲拆解、多模型精写、公式插图排版与矢量 PDF 编译，全程防中断续跑，无需手动值守。
        </p>
      </div>

      <form onSubmit={onSubmitPipeline} className="space-y-4">
        {/* Primary Focal Anchor: Conversational Multimodal Studio Box (Gemini Canvas / Claude Artifacts Flow) */}
        <div
          onDragOver={(e) => {
            e.preventDefault();
            setIsDragging(true);
          }}
          onDragLeave={() => setIsDragging(false)}
          onDrop={handleDrop}
          className={`bg-white border rounded-2xl transition-colors ${
            isDragging
              ? 'border-blue-600 bg-blue-50/20'
              : validationError
                ? 'border-red-400'
                : 'border-slate-200 focus-within:border-slate-400'
          }`}
        >
          {/* Top Compact Studio Parameter Strip */}
          <div className="px-4 py-3 border-b border-slate-100 flex flex-wrap items-center justify-between gap-2.5">
            <div className="flex flex-wrap items-center gap-2">
              {/* Document Mode */}
              <div
                className="inline-flex items-center gap-0.5 p-0.5 bg-slate-100 rounded-lg"
                role="group"
                aria-label="生成文档形态"
              >
                <button
                  type="button"
                  onClick={() => onModeChange('lecture_notes')}
                  className={`inline-flex items-center gap-1.5 py-1.5 px-2.5 text-xs font-semibold rounded-md transition-colors whitespace-nowrap shrink-0 ${
                    mode === 'lecture_notes'
                      ? 'bg-white text-slate-900 shadow-2xs'
                      : 'text-slate-600 hover:text-slate-900'
                  }`}
                >
                  <BookOpen className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
                  <span>课程讲义 PDF</span>
                </button>
                <button
                  type="button"
                  onClick={() => onModeChange('workbook')}
                  className={`inline-flex items-center gap-1.5 py-1.5 px-2.5 text-xs font-semibold rounded-md transition-colors whitespace-nowrap shrink-0 ${
                    mode === 'workbook'
                      ? 'bg-white text-slate-900 shadow-2xs'
                      : 'text-slate-600 hover:text-slate-900'
                  }`}
                >
                  <ClipboardCheck className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
                  <span>练习题册 PDF</span>
                </button>
              </div>

              {/* Page Orientation (Auto / Portrait A4 / Landscape PPT) */}
              {onPageOrientationChange && (
                <div
                  className="inline-flex items-center gap-0.5 p-0.5 bg-slate-100 rounded-lg"
                  role="group"
                  aria-label="PDF 页面版式"
                >
                  {(
                    [
                      { key: 'auto', label: '自动版式' },
                      { key: 'portrait', label: '竖版 A4' },
                      { key: 'landscape', label: '横版演示 PPT' },
                    ] as const
                  ).map((opt) => (
                    <button
                      key={opt.key}
                      type="button"
                      onClick={() => onPageOrientationChange(opt.key)}
                      className={`py-1.5 px-2.5 text-xs font-semibold rounded-md transition-colors whitespace-nowrap shrink-0 ${
                        pageOrientation === opt.key
                          ? 'bg-white text-slate-900 shadow-2xs'
                          : 'text-slate-600 hover:text-slate-900'
                      }`}
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>
              )}

              {/* Depth Preset */}
              <div
                className="inline-flex items-center gap-0.5 p-0.5 bg-slate-100 rounded-lg"
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
                    className={`py-1.5 px-2.5 text-xs font-semibold rounded-md transition-colors whitespace-nowrap shrink-0 ${
                      depth === item.key
                        ? 'bg-white text-slate-900 shadow-2xs'
                        : 'text-slate-600 hover:text-slate-900'
                    }`}
                  >
                    {item.label}
                  </button>
                ))}
              </div>

              {/* Multi-Volume Split Mode */}
              <div
                className="inline-flex items-center gap-0.5 p-0.5 bg-slate-100 rounded-lg"
                role="group"
                aria-label="文件分册输出策略"
              >
                {(
                  [
                    { key: 'auto', label: '自动分册' },
                    { key: 'multi_volume', label: '多册独立' },
                    { key: 'single_file', label: '单册合编' },
                  ] as const
                ).map((opt) => (
                  <button
                    key={opt.key}
                    type="button"
                    onClick={() => onVolumeSplitModeChange(opt.key)}
                    className={`py-1.5 px-2.5 text-xs font-semibold rounded-md transition-colors whitespace-nowrap shrink-0 ${
                      volumeSplitMode === opt.key
                        ? 'bg-white text-slate-900 shadow-2xs'
                        : 'text-slate-600 hover:text-slate-900'
                    }`}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
            </div>
          </div>

          {/* Attachment Chips Tray + Chunked Upload Progress */}
          {(attachments.length > 0 || isParsingFiles || uploadProgress) && (
            <div className="px-4 pt-3.5 pb-2 flex flex-wrap gap-2.5 border-b border-slate-100">
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

          {/* Main Conversational Prompt Textarea */}
          <div className="p-4 sm:p-5">
            <label htmlFor="carbon-prompt-input" className="sr-only">
              输入讲义或练习题册主题要求
            </label>
            <textarea
              id="carbon-prompt-input"
              rows={5}
              value={prompt}
              onChange={(e) => onPromptChange(e.target.value)}
              onPaste={handlePaste}
              onKeyDown={(e) => {
                if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && !isRunningPipeline && !isParsingFiles) {
                  onSubmitPipeline(e as unknown as React.FormEvent);
                }
              }}
              placeholder={
                mode === 'lecture_notes'
                  ? '描述您想制作的课程讲义（例如：章节范围、是否需要横版 PPT 演示版式、是否将例题答案单独分册输出），可直接粘贴 Google Drive / arXiv / 网页链接或拖入不限大小教材...'
                  : '描述练习题册考察范围与梯度要求（例如：基础+进阶+压轴证明题，正题与评分标准答案独立分册输出），支持粘贴真题链接或绑定已完成讲义...'
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

          {/* Live Color Theme Swatches & Figure Toggle Row */}
          <div className="px-4 py-2.5 border-t border-slate-100 flex flex-wrap items-center justify-between gap-3">
            <div
              className="flex flex-wrap items-center gap-1.5"
              role="radiogroup"
              aria-label="出版级填色排版配色主题"
            >
              <span className="text-xs text-slate-500 mr-1 whitespace-nowrap">排版配色:</span>
              {(Object.keys(COLOR_PALETTE_THEMES) as ColorPaletteTheme[]).map((themeKey) => {
                const style = THEME_SWATCH_STYLES[themeKey];
                const active = colorTheme === themeKey;
                return (
                  <button
                    key={themeKey}
                    type="button"
                    role="radio"
                    aria-checked={active}
                    onClick={() => onColorThemeChange(themeKey)}
                    className={`inline-flex items-center gap-1.5 px-2.5 py-1 text-xs rounded-md border transition-colors whitespace-nowrap shrink-0 ${
                      active
                        ? style.activeRing
                        : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50'
                    }`}
                  >
                    <span
                      className={`w-2.5 h-2.5 rounded-xs shrink-0 ${style.swatchBg}`}
                      aria-hidden="true"
                    />
                    <span>{style.shortLabel}</span>
                  </button>
                );
              })}
            </div>

            <label className="inline-flex items-center gap-1.5 text-xs text-slate-700 cursor-pointer whitespace-nowrap">
              <input
                id="auto-generate-figures-toggle"
                type="checkbox"
                checked={autoGenerateFigures}
                onChange={(e) => onAutoGenerateFiguresChange(e.target.checked)}
                className="w-3.5 h-3.5 rounded border-slate-300 text-blue-600 focus:ring-blue-500 cursor-pointer"
              />
              <span>Nano Banana 科学配图</span>
            </label>
          </div>

          {/* Bottom Composer Action Bar */}
          <div className="px-4 py-3 bg-slate-50/70 border-t border-slate-200 rounded-b-2xl flex flex-wrap items-center justify-between gap-3">
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
                className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium text-slate-700 bg-white border border-slate-200 rounded-lg hover:bg-slate-100 disabled:opacity-50 transition-colors whitespace-nowrap shrink-0"
              >
                <Paperclip className="w-3.5 h-3.5 text-slate-500" aria-hidden="true" />
                <span>上传文件（不限大小）</span>
              </button>

              <VoiceDictationButton
                disabled={isParsingFiles || isRunningPipeline}
                label="语音录入"
                onTranscribed={(spoken) => {
                  onPromptChange(prompt.trim() ? `${prompt.trim()} ${spoken}` : spoken);
                }}
                onError={onVoiceError}
              />

              <button
                type="button"
                aria-expanded={showAdvancedPanel}
                onClick={() => setShowAdvancedPanel((prev) => !prev)}
                className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium text-slate-700 bg-white border border-slate-200 rounded-lg hover:bg-slate-100 transition-colors whitespace-nowrap shrink-0"
              >
                <SlidersHorizontal className="w-3.5 h-3.5 text-slate-500" aria-hidden="true" />
                <span>
                  高级记忆与云配置
                  {sourceContextJobIds.length > 0 ? ` (已绑 ${sourceContextJobIds.length})` : ''}
                </span>
                {showAdvancedPanel ? (
                  <ChevronUp className="w-3.5 h-3.5 text-slate-400" aria-hidden="true" />
                ) : (
                  <ChevronDown className="w-3.5 h-3.5 text-slate-400" aria-hidden="true" />
                )}
              </button>
            </div>

            <button
              type="submit"
              disabled={isRunningPipeline || isParsingFiles}
              className="inline-flex items-center gap-2 px-5 py-2.5 text-xs sm:text-sm font-semibold text-white bg-blue-600 rounded-lg hover:bg-blue-700 disabled:opacity-60 transition-colors whitespace-nowrap shrink-0"
            >
              {isRunningPipeline ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" />
                  <span>正在启动全自动流水线...</span>
                </>
              ) : (
                <>
                  <Play className="w-4 h-4 fill-current" aria-hidden="true" />
                  <span>启动全自动生成</span>
                </>
              )}
            </button>
          </div>
        </div>

        {/* Quiet Inline Live Intent & Cost Summary Line (Zero Pill Boxes) */}
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 px-1 text-xs text-slate-500 font-mono tabular-nums">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 font-sans">
            <span className={resolvedOrientation === 'landscape' ? 'text-blue-700 font-medium' : ''}>
              {resolvedOrientation === 'landscape'
                ? '版式：横版宽屏演示 PPT (297×210mm)'
                : '版式：竖版标准 A4 (210×297mm)'}
            </span>
            <span aria-hidden="true">·</span>
            <span
              className={
                liveMultiVolumeDetection.shouldSplitVolumes ? 'text-blue-700 font-medium' : ''
              }
            >
              {liveMultiVolumeDetection.shouldSplitVolumes
                ? liveMultiVolumeDetection.reasonSummary
                : '输出：单份完整矢量 PDF'}
            </span>
            <span aria-hidden="true">·</span>
            <span className="font-mono tabular-nums">
              单模块甜区 ~{singleCallWordsTarget.toLocaleString()} 字
            </span>
          </div>

          <div className="flex items-center gap-2">
            <span>
              预估 ~{liveCostEstimate.estimatedPages} 页 ·{' '}
              {(liveCostEstimate.estimatedTotalTokens / 1000).toFixed(1)}k Tokens
            </span>
            <span aria-hidden="true">·</span>
            <span className="font-sans">
              {accountProfile?.isSuperAdmin
                ? '超管免计费'
                : accountProfile?.subscriptionActive
                  ? '包月配额结算'
                  : `预估 ¥${liveCostEstimate.payPerPdfPriceCny.toFixed(2)}`}
            </span>
          </div>
        </div>

        {validationError && (
          <p role="alert" className="text-xs font-medium text-red-600 px-1">
            {validationError}
          </p>
        )}

        {/* Collapsible Advanced Drawer: Long-Context Reference Binding, Personal Cloud & 12-Model Registry */}
        {showAdvancedPanel && (
          <div className="bg-white border border-slate-200 rounded-xl divide-y divide-slate-200">
            {/* Section A: Strong Historical Memory & Long-Context Reference Binding */}
            <div className="p-4 space-y-3">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <BrainCircuit className="w-4 h-4 text-blue-600 shrink-0" aria-hidden="true" />
                  <label
                    htmlFor="historical-memory-toggle"
                    className="text-xs font-semibold text-slate-900 cursor-pointer"
                  >
                    强历史记忆与超长上下文基准绑定（自动对齐跨任务符号体系、定理与习题编号）
                  </label>
                </div>
                <div className="flex items-center gap-3 shrink-0">
                  {sourceContextJobIds.length > 0 && (
                    <button
                      type="button"
                      onClick={onClearSourceContextJobs}
                      className="text-xs text-blue-700 hover:underline whitespace-nowrap shrink-0"
                    >
                      清空已选 ({sourceContextJobIds.length})
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

              {availableHistoricalJobs.length > 0 && (
                <div className="space-y-1.5">
                  <div className="text-xs text-slate-600">
                    勾选已有已完成文档作为本次生成的长上下文基准（已选{' '}
                    <span className="font-mono tabular-nums font-semibold">
                      {sourceContextJobIds.length}
                    </span>{' '}
                    份）：
                  </div>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-2 max-h-40 overflow-y-auto pr-1">
                    {availableHistoricalJobs.slice(0, 10).map((hj) => {
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
                              {hj.charCount.toLocaleString()} 字 · {hj.estimatedPages} 页
                            </div>
                          </div>
                        </label>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>

            {/* Section B: Personal Google Cloud Archive & Billing Summary */}
            <div className="p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
              <div className="space-y-1 min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <FolderGit2 className="w-4 h-4 text-blue-600 shrink-0" aria-hidden="true" />
                  <label
                    htmlFor="auto-archive-toggle"
                    className="text-xs font-semibold text-slate-900 cursor-pointer"
                  >
                    个人 Google Cloud 自动托管与多终端同步（关机断网不影响后台生成）
                  </label>
                </div>
                <p className="text-xs text-slate-500 truncate">
                  归档路径：<span className="font-mono text-slate-700">{previewDrivePath.fullPath}</span>
                </p>
              </div>

              <div className="flex flex-wrap items-center gap-2.5 shrink-0">
                {!hasDriveToken && onRequestGoogleSignIn && (
                  <button
                    type="button"
                    disabled={isSigningIn}
                    onClick={onRequestGoogleSignIn}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-blue-700 bg-blue-50 border border-blue-200 rounded-lg hover:bg-blue-100 disabled:opacity-60 transition-colors whitespace-nowrap shrink-0"
                  >
                    <span>连接个人 Google Cloud</span>
                  </button>
                )}
                <div className="flex items-center gap-1.5">
                  <label
                    htmlFor="drive-root-folder-input"
                    className="text-xs text-slate-500 whitespace-nowrap"
                  >
                    目录:
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
                {onOpenBillingTab && (
                  <button
                    type="button"
                    onClick={onOpenBillingTab}
                    className="inline-flex items-center gap-1 px-3 py-1.5 text-xs font-semibold text-slate-700 bg-slate-100 border border-slate-200 rounded-lg hover:bg-slate-200 transition-colors whitespace-nowrap shrink-0"
                  >
                    <Coins className="w-3.5 h-3.5 text-slate-500" aria-hidden="true" />
                    <span>计费与配额详情</span>
                  </button>
                )}
              </div>
            </div>

            {/* Section C: Multi-Model Tool Registry Disclosure */}
            <div className="p-4 space-y-3">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                <div className="flex items-center gap-2 text-xs text-slate-600">
                  <Cpu className="w-4 h-4 text-blue-600 shrink-0" aria-hidden="true" />
                  <span>
                    已接入{' '}
                    <strong className="text-slate-900 font-mono tabular-nums">
                      {DOCUMENT_TOOL_MODEL_REGISTRY.length}
                    </strong>{' '}
                    款专精工具模型（Carbon 主控编排 · Argon 演算 · Hydrogen 排版 · Nano Banana 配图）
                  </span>
                </div>
                <button
                  type="button"
                  aria-expanded={showModelRegistry}
                  onClick={() => setShowModelRegistry((prev) => !prev)}
                  className="inline-flex items-center gap-1 text-xs font-semibold text-blue-700 hover:text-blue-800 whitespace-nowrap shrink-0 self-start sm:self-auto"
                >
                  <span>
                    {showModelRegistry
                      ? '收起工具模型明细'
                      : `查看全部 ${DOCUMENT_TOOL_MODEL_REGISTRY.length} 款工具模型分工`}
                  </span>
                  {showModelRegistry ? (
                    <ChevronUp className="w-3.5 h-3.5" aria-hidden="true" />
                  ) : (
                    <ChevronDown className="w-3.5 h-3.5" aria-hidden="true" />
                  )}
                </button>
              </div>

              {showModelRegistry && (
                <div className="border border-slate-200 rounded-lg overflow-x-auto">
                  <table className="w-full text-left border-collapse text-xs">
                    <thead>
                      <tr className="bg-slate-50 border-b border-slate-200 text-slate-600">
                        <th className="py-2 px-3 font-semibold whitespace-nowrap">模型代号 / ID</th>
                        <th className="py-2 px-3 font-semibold whitespace-nowrap">专精板块能力</th>
                        <th className="py-2 px-3 font-semibold whitespace-nowrap">介入节点</th>
                        <th className="py-2 px-3 font-semibold text-right whitespace-nowrap">
                          成本权重
                        </th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {DOCUMENT_TOOL_MODEL_REGISTRY.map((entry) => (
                        <tr key={entry.modelId} className="hover:bg-slate-50/70 align-top">
                          <td className="py-2 px-3 whitespace-nowrap">
                            <div className="font-semibold text-slate-900">{entry.codeName}</div>
                            <div className="text-[11px] font-mono text-slate-500">
                              {entry.modelId}
                            </div>
                          </td>
                          <td className="py-2 px-3 text-slate-700 min-w-[220px] leading-relaxed">
                            {entry.bestForSummary}
                          </td>
                          <td className="py-2 px-3 text-slate-600 max-w-[190px] leading-relaxed">
                            {entry.workflowStages.join(' · ')}
                          </td>
                          <td className="py-2 px-3 text-right font-mono tabular-nums text-slate-800 whitespace-nowrap">
                            {(entry.relativeTokenCostIndex * 100).toFixed(0)}%
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </div>
        )}
      </form>

      {/* Starter Prompt Cards (Clean 2-Column Editorial Examples) */}
      <div className="space-y-3 pt-2">
        <div className="flex items-center justify-between">
          <h2 className="text-xs font-semibold text-slate-700">
            精选示例模板（涵盖课程讲义、分级题册、多卷独立分册与横版 PPT 演示课件）
          </h2>
          <span className="text-xs text-slate-500">点击一键载入</span>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {STARTER_TEMPLATES.map((tpl) => (
            <button
              key={tpl.id}
              type="button"
              onClick={() => {
                onModeChange(tpl.mode);
                onVolumeSplitModeChange('auto');
                if (onPageOrientationChange) {
                  onPageOrientationChange('auto');
                }
                onPromptChange(tpl.prompt);
              }}
              className="text-left p-3.5 bg-white border border-slate-200 rounded-xl hover:border-slate-300 hover:bg-slate-50/60 transition-colors space-y-1.5"
            >
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs font-semibold text-slate-900 truncate">{tpl.label}</span>
                <ArrowUpRight className="w-3.5 h-3.5 text-slate-400 shrink-0" aria-hidden="true" />
              </div>
              <p className="text-xs text-slate-500 line-clamp-2 leading-relaxed">{tpl.prompt}</p>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
};
