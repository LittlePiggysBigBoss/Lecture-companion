import React, { useRef, useState } from 'react';
import {
  BookOpen,
  ClipboardCheck,
  FilePlus2,
  FileText,
  GitBranchPlus,
  Image as ImageIcon,
  Loader2,
  Paperclip,
  Sparkles,
  X,
} from 'lucide-react';
import type {
  DepthPreset,
  DocMode,
  PipelineJob,
  PostCompletionExpansionMode,
  ScannedLinkResult,
  UploadedAttachment,
} from '../types';
import {
  formatFileSize,
  uploadFilesUnlimited,
} from '../services/fileAndVoiceClient';
import type { UploadProgressState } from '../services/fileAndVoiceClient';
import { LinkRecognitionBar } from './LinkRecognitionBar';
import { VoiceDictationButton } from './VoiceDictationButton';

interface PostCompletionExpansionCardProps {
  job: PipelineJob;
  driveToken?: string | null;
  isExpanding: boolean;
  onExpandCompletedJob: (params: {
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
}

export const PostCompletionExpansionCard: React.FC<PostCompletionExpansionCardProps> = ({
  job,
  driveToken,
  isExpanding,
  onExpandCompletedJob,
  onLoadIntoComposerWithMemory,
}) => {
  const [expansionMode, setExpansionMode] =
    useState<PostCompletionExpansionMode>('append_in_place');
  const [targetDocMode, setTargetDocMode] = useState<DocMode>(
    job.mode === 'lecture_notes' ? 'workbook' : 'lecture_notes'
  );
  const [depth, setDepth] = useState<DepthPreset>(job.depth || 'comprehensive');
  const [prompt, setPrompt] = useState('');
  const [inputSource, setInputSource] = useState<'text' | 'voice'>('text');
  const [attachments, setAttachments] = useState<UploadedAttachment[]>([]);
  const [scannedLinks, setScannedLinks] = useState<ScannedLinkResult[]>([]);
  const [uploadProgress, setUploadProgress] = useState<UploadProgressState | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);

  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const quickPresets: Array<{
    label: string;
    mode: PostCompletionExpansionMode;
    docMode: DocMode;
    text: string;
  }> =
    job.mode === 'lecture_notes'
      ? [
          {
            label: '在本文末尾顺延扩编后续章节',
            mode: 'append_in_place',
            docMode: 'lecture_notes',
            text: '请严格基于当前已完成讲义的章节脉络、数学符号约定与末尾编号，无缝顺延扩编后续进阶核心章节，补充直观图示说明、完整定理证明与多梯度综合例题。',
          },
          {
            label: '基于本讲义派生配套分级题册',
            mode: 'derive_new_job',
            docMode: 'workbook',
            text: '请完整继承本份已完成讲义的全部知识点范围、公式记号与难度体系，派生制作一份完全配套的多样化分级练习题册（含基础巩固、真题变式、竞赛压轴题及每道题的详尽分步解答与评分标准）。',
          },
          {
            label: '派生独立《例题与习题全解答案册》',
            mode: 'derive_new_job',
            docMode: 'workbook',
            text: '请针对本份已完成讲义涉及的全部章节考点与高阶模型，独立派生编制一份《深度题解与易错辨析专册》，要求一题多解、标注易错陷阱与竞赛拔高衔接。',
          },
        ]
      : [
          {
            label: '在当前题册末尾增补压轴新题组',
            mode: 'append_in_place',
            docMode: 'workbook',
            text: '请顺延当前已完成练习题册的末尾题号与考察风格，继续扩编一组高区分度综合拔高与压轴证明题，每题附完整分步推导与评分采分点。',
          },
          {
            label: '基于本题册派生系统方法论讲义',
            mode: 'derive_new_job',
            docMode: 'lecture_notes',
            text: '请基于本份已完成练习题册覆盖的全部题型、物理/数学模型与解题技巧，系统提炼并派生撰写一份《核心理论推导与解题方法论讲义》，做到图文详实、例题与题册严密呼应。',
          },
        ];

  const handleFilesSelected = async (files: FileList | File[]) => {
    setLocalError(null);
    try {
      const uploaded = await uploadFilesUnlimited(files, setUploadProgress);
      if (uploaded.length > 0) {
        setAttachments((prev) => [...prev, ...uploaded]);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setLocalError(msg);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!prompt.trim() && attachments.length === 0) {
      setLocalError('请选择上方快捷扩展方向，或输入/口述继续扩展的具体要求（支持直接粘贴云盘/网页链接）。');
      return;
    }
    setLocalError(null);
    await onExpandCompletedJob({
      sourceJob: job,
      expansionMode,
      expansionPrompt: prompt.trim(),
      targetDocMode: expansionMode === 'derive_new_job' ? targetDocMode : job.mode,
      depth,
      source: inputSource,
      attachments,
      scannedLinks,
    });
    setPrompt('');
    setAttachments([]);
    setScannedLinks([]);
    setInputSource('text');
  };

  return (
    <section
      aria-label="基于已完成内容继续扩展任务"
      className="bg-white border border-blue-200 rounded-xl p-5 space-y-4 no-print"
    >
      <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-3">
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <GitBranchPlus className="w-4 h-4 text-blue-600 shrink-0" aria-hidden="true" />
            <h2 className="text-sm sm:text-base font-bold text-slate-900">
              基于已完成全文长上下文继续扩展任务（强历史记忆已锁定 {job.charCount.toLocaleString()} 字）
            </h2>
          </div>
          <p className="text-xs text-slate-600 leading-relaxed">
            Gemini 4 Carbon 已完整记忆本文档全部章节结构、公式符号与编号锚点。您可在本文末尾无缝续编新章节，或基于全文一键派生配套练习题册/下册讲义，同时支持粘贴云盘链接自动抓取。
          </p>
        </div>

        {onLoadIntoComposerWithMemory && (
          <button
            type="button"
            onClick={() =>
              onLoadIntoComposerWithMemory(
                job,
                job.mode === 'lecture_notes' ? 'workbook' : 'lecture_notes'
              )
            }
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-blue-700 bg-blue-50 border border-blue-200 rounded-lg hover:bg-blue-100 transition-colors whitespace-nowrap shrink-0 self-start lg:self-center"
          >
            <FilePlus2 className="w-3.5 h-3.5" aria-hidden="true" />
            <span>载入新建工作台自定义派生</span>
          </button>
        )}
      </div>

      {/* Mode Switcher: Seamless In-Place Continuation vs Derive New Companion Document */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pt-1">
        <div
          className="inline-flex flex-wrap items-center gap-1 p-1 bg-slate-100 rounded-lg"
          role="group"
          aria-label="选择任务完成后扩展方式"
        >
          <button
            type="button"
            onClick={() => setExpansionMode('append_in_place')}
            className={`px-3 py-1.5 text-xs font-semibold rounded-md transition-colors whitespace-nowrap shrink-0 ${
              expansionMode === 'append_in_place'
                ? 'bg-white text-slate-900 shadow-xs'
                : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            方式一：在本文末尾无缝续编新章节/题组
          </button>
          <button
            type="button"
            onClick={() => setExpansionMode('derive_new_job')}
            className={`px-3 py-1.5 text-xs font-semibold rounded-md transition-colors whitespace-nowrap shrink-0 ${
              expansionMode === 'derive_new_job'
                ? 'bg-white text-slate-900 shadow-xs'
                : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            方式二：基于全文记忆派生新讲义 / 配套题册
          </button>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {expansionMode === 'derive_new_job' && (
            <div
              className="inline-flex items-center gap-1 p-1 bg-slate-100 rounded-lg"
              role="group"
              aria-label="派生文档类型"
            >
              <button
                type="button"
                onClick={() => setTargetDocMode('lecture_notes')}
                className={`inline-flex items-center gap-1 px-2.5 py-1 text-xs font-semibold rounded transition-colors whitespace-nowrap shrink-0 ${
                  targetDocMode === 'lecture_notes'
                    ? 'bg-white text-slate-900 shadow-xs'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                <BookOpen className="w-3 h-3" aria-hidden="true" />
                <span>派生讲义 PDF</span>
              </button>
              <button
                type="button"
                onClick={() => setTargetDocMode('workbook')}
                className={`inline-flex items-center gap-1 px-2.5 py-1 text-xs font-semibold rounded transition-colors whitespace-nowrap shrink-0 ${
                  targetDocMode === 'workbook'
                    ? 'bg-white text-slate-900 shadow-xs'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                <ClipboardCheck className="w-3 h-3" aria-hidden="true" />
                <span>派生练习题册 PDF</span>
              </button>
            </div>
          )}

          <select
            aria-label="扩展任务深度档位"
            value={depth}
            onChange={(e) => setDepth(e.target.value as DepthPreset)}
            className="px-2.5 py-1.5 text-xs font-medium text-slate-700 bg-slate-50 border border-slate-200 rounded-lg focus:outline-none focus:border-blue-600"
          >
            <option value="standard">标准精编扩写</option>
            <option value="comprehensive">深度详尽扩写</option>
            <option value="exhaustive">全书穷尽扩写</option>
          </select>
        </div>
      </div>

      {/* Quick One-Click Academic Expansion Presets */}
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs text-slate-500 whitespace-nowrap">快捷扩展模板：</span>
        {quickPresets.map((preset) => (
          <button
            key={preset.label}
            type="button"
            onClick={() => {
              setExpansionMode(preset.mode);
              setTargetDocMode(preset.docMode);
              setPrompt(preset.text);
              setLocalError(null);
            }}
            className="px-2.5 py-1 text-xs font-medium text-slate-700 bg-slate-50 border border-slate-200 rounded-lg hover:bg-slate-100 hover:text-slate-900 transition-colors whitespace-nowrap shrink-0"
          >
            {preset.label}
          </button>
        ))}
      </div>

      <form onSubmit={handleSubmit} className="space-y-3">
        {(attachments.length > 0 || uploadProgress) && (
          <div className="flex flex-wrap items-center gap-2">
            {attachments.map((att) => (
              <div
                key={att.id}
                className="flex items-center gap-2 pl-2.5 pr-1.5 py-1.5 bg-slate-50 border border-slate-200 rounded-lg max-w-[260px]"
              >
                {att.kind === 'image' ? (
                  <ImageIcon className="w-3.5 h-3.5 text-blue-600 shrink-0" aria-hidden="true" />
                ) : (
                  <FileText className="w-3.5 h-3.5 text-slate-600 shrink-0" aria-hidden="true" />
                )}
                <div className="min-w-0 flex-1">
                  <p className="text-xs font-medium text-slate-800 truncate">{att.name}</p>
                  <p className="text-[11px] text-slate-500 font-mono tabular-nums">
                    {formatFileSize(att.size)}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => setAttachments((prev) => prev.filter((x) => x.id !== att.id))}
                  aria-label={`移除扩展参考附件 ${att.name}`}
                  className="p-1 text-slate-400 hover:text-slate-700 rounded"
                >
                  <X className="w-3.5 h-3.5" aria-hidden="true" />
                </button>
              </div>
            ))}

            {uploadProgress && (
              <div className="flex items-center gap-2 px-3 py-1.5 bg-blue-50 border border-blue-200 rounded-lg text-xs text-blue-800">
                <Loader2 className="w-3.5 h-3.5 animate-spin text-blue-600 shrink-0" aria-hidden="true" />
                <span className="truncate max-w-[160px]">{uploadProgress.fileName}</span>
                <span className="font-mono tabular-nums font-semibold">
                  {uploadProgress.percent}%
                </span>
              </div>
            )}
          </div>
        )}

        <div className="border border-slate-200 rounded-xl overflow-hidden focus-within:border-blue-600 bg-slate-50/50">
          <label htmlFor="post-completion-expand-input" className="sr-only">
            输入基于已完成内容继续扩展的要求或云盘链接
          </label>
          <textarea
            id="post-completion-expand-input"
            rows={3}
            value={prompt}
            onChange={(e) => {
              setPrompt(e.target.value);
              if (localError) setLocalError(null);
            }}
            placeholder={
              expansionMode === 'append_in_place'
                ? '输入需要顺延扩编的新章节或新题组要求（例如：“继续扩写第4章刚体转动与角动量守恒，并结合 https://drive.google.com/... 中的真题补充例题”），完成后自动合编更新整本 PDF...'
                : '输入基于本文全量长上下文派生新文档的要求（例如：“按照本讲义的符号与章节顺序，生成一份包含 PhysicsBowl 与 BPhO 进阶题的配套练习题册”），支持直接粘贴 Google Drive 链接或网页 URL...'
            }
            className="w-full p-3.5 text-sm text-slate-900 placeholder:text-slate-400 bg-transparent focus:outline-none leading-relaxed resize-y"
          />

          <LinkRecognitionBar
            text={prompt}
            driveToken={driveToken}
            onIngestedAttachments={(ingested) => {
              setAttachments((prev) => {
                const existingServerIds = new Set(prev.map((p) => p.serverFileId).filter(Boolean));
                const filtered = ingested.filter(
                  (item) => !item.serverFileId || !existingServerIds.has(item.serverFileId)
                );
                return [...prev, ...filtered];
              });
            }}
            onScannedLinksChange={setScannedLinks}
          />
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <input
              ref={fileInputRef}
              type="file"
              multiple
              onChange={(e) => {
                if (e.target.files?.length) {
                  void handleFilesSelected(e.target.files);
                  e.target.value = '';
                }
              }}
              className="hidden"
              id="post-expand-file-input"
            />
            <button
              type="button"
              disabled={Boolean(uploadProgress) || isExpanding}
              onClick={() => fileInputRef.current?.click()}
              className="inline-flex items-center gap-2 px-3.5 py-2 text-xs font-medium text-slate-700 bg-white border border-slate-200 rounded-lg hover:bg-slate-100 disabled:opacity-50 transition-colors whitespace-nowrap shrink-0"
            >
              <Paperclip className="w-3.5 h-3.5 text-slate-500" aria-hidden="true" />
              <span>上传参考文件（不限大小）</span>
            </button>

            <VoiceDictationButton
              disabled={Boolean(uploadProgress) || isExpanding}
              label="语音录入扩展要求"
              onTranscribed={(spoken) => {
                setInputSource('voice');
                setPrompt((prev) => (prev.trim() ? `${prev.trim()} ${spoken}` : spoken));
              }}
              onError={(err) => setLocalError(err)}
            />
          </div>

          <button
            type="submit"
            disabled={Boolean(uploadProgress) || isExpanding}
            className="inline-flex items-center gap-2 px-4 py-2 text-xs sm:text-sm font-semibold text-white bg-blue-600 rounded-lg hover:bg-blue-700 disabled:opacity-60 transition-colors whitespace-nowrap shrink-0"
          >
            {isExpanding ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" />
                <span>正在启动长上下文扩展任务...</span>
              </>
            ) : (
              <>
                <Sparkles className="w-4 h-4" aria-hidden="true" />
                <span>
                  {expansionMode === 'append_in_place'
                    ? '启动原文档无缝续编并更新云端 PDF'
                    : '基于本文长上下文启动派生新任务'}
                </span>
              </>
            )}
          </button>
        </div>

        {localError && (
          <p role="alert" className="text-xs font-medium text-red-600">
            {localError}
          </p>
        )}
      </form>
    </section>
  );
};
