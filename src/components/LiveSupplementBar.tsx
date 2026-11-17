import React, { useRef, useState } from 'react';
import {
  CheckCircle2,
  FileText,
  GitMerge,
  Image as ImageIcon,
  Loader2,
  MessageSquarePlus,
  Paperclip,
  Send,
  X,
} from 'lucide-react';
import type { PipelineJob, UploadedAttachment } from '../types';
import {
  formatFileSize,
  uploadFilesUnlimited,
} from '../services/fileAndVoiceClient';
import type { UploadProgressState } from '../services/fileAndVoiceClient';
import { LinkRecognitionBar } from './LinkRecognitionBar';
import { VoiceDictationButton } from './VoiceDictationButton';

interface LiveSupplementBarProps {
  job: PipelineJob;
  driveToken?: string | null;
  isSubmittingSupplement: boolean;
  onSubmitSupplement: (params: {
    jobId: string;
    text: string;
    source: 'text' | 'voice';
    attachments: UploadedAttachment[];
  }) => Promise<void>;
}

export const LiveSupplementBar: React.FC<LiveSupplementBarProps> = ({
  job,
  driveToken,
  isSubmittingSupplement,
  onSubmitSupplement,
}) => {
  const [text, setText] = useState('');
  const [inputSource, setInputSource] = useState<'text' | 'voice'>('text');
  const [attachments, setAttachments] = useState<UploadedAttachment[]>([]);
  const [uploadProgress, setUploadProgress] = useState<UploadProgressState | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);
  const [isDragging, setIsDragging] = useState(false);

  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const isJobRunning =
    job.stage === 'planning' ||
    job.stage === 'executing' ||
    job.stage === 'compiling_pdf' ||
    job.stage === 'uploading_drive';

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

  const handlePaste = async (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    const files: File[] = [];
    for (let i = 0; i < items.length; i++) {
      if (items[i].kind === 'file') {
        const f = items[i].getAsFile();
        if (f) files.push(f);
      }
    }
    if (files.length > 0) {
      await handleFilesSelected(files);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!text.trim() && attachments.length === 0) {
      setLocalError('请输入补充/修正提示文字、使用语音录入，或上传补充参考文件。');
      return;
    }
    setLocalError(null);
    await onSubmitSupplement({
      jobId: job.id,
      text: text.trim(),
      source: inputSource,
      attachments,
    });
    setText('');
    setInputSource('text');
    setAttachments([]);
  };

  const directives = job.supplementalDirectives || [];

  return (
    <section
      aria-label="运行中实时补充要求与修正提示"
      onDragOver={(e) => {
        e.preventDefault();
        setIsDragging(true);
      }}
      onDragLeave={() => setIsDragging(false)}
      onDrop={(e) => {
        e.preventDefault();
        setIsDragging(false);
        if (e.dataTransfer.files?.length) {
          void handleFilesSelected(e.dataTransfer.files);
        }
      }}
      className={`bg-white border rounded-xl p-5 space-y-4 transition-colors no-print ${
        isDragging ? 'border-blue-600 bg-blue-50/20' : 'border-slate-200'
      }`}
    >
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <MessageSquarePlus className="w-4 h-4 text-blue-600 shrink-0" aria-hidden="true" />
          <h2 className="text-sm font-semibold text-slate-900">
            实时新增要求与智能整合跟进（语音录入 · 不限大小上传 · 动态重排工作流与分册）
          </h2>
        </div>
        <span className="text-xs text-slate-500">
          {isJobRunning
            ? '自动去重消解前后冲突并重排待执行轮次/分册，不打断正在生成的当前轮'
            : '自动整合历史全部要求并规划高效满载增补轮次，完成后同步个人云盘'}
        </span>
      </div>

      {/* Consolidated Requirement Synthesis & Token Efficiency Strip */}
      {job.consolidatedRequirements && (
        <div className="bg-blue-50/60 border border-blue-200/80 rounded-lg px-3.5 py-2.5 space-y-1.5">
          <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
            <div className="flex items-center gap-1.5 font-semibold text-blue-950">
              <GitMerge className="w-3.5 h-3.5 text-blue-600 shrink-0" aria-hidden="true" />
              <span>
                智能需求整合总纲 v{job.consolidatedRequirements.version}（自动跟进变更并消解冲突）
              </span>
            </div>
            <div className="flex flex-wrap items-center gap-2 text-[11px] font-mono tabular-nums text-blue-800">
              <span>
                活跃规则{' '}
                {
                  job.consolidatedRequirements.activeRules.filter((r) => r.status === 'active')
                    .length
                }{' '}
                条
              </span>
              {job.consolidatedRequirements.activeRules.some((r) => r.status === 'superseded') && (
                <>
                  <span aria-hidden="true">·</span>
                  <span>
                    已覆盖旧规则{' '}
                    {
                      job.consolidatedRequirements.activeRules.filter(
                        (r) => r.status === 'superseded'
                      ).length
                    }{' '}
                    条
                  </span>
                </>
              )}
              {job.consolidatedRequirements.tokenSavingsEstimatePct > 0 && (
                <>
                  <span aria-hidden="true">·</span>
                  <span className="text-emerald-700 font-semibold">
                    续写上下文去重压缩省约 {job.consolidatedRequirements.tokenSavingsEstimatePct}% Token
                  </span>
                </>
              )}
            </div>
          </div>
          <p className="text-xs text-slate-700 whitespace-pre-line leading-relaxed line-clamp-3">
            {job.consolidatedRequirements.synthesizedMasterBrief}
          </p>
        </div>
      )}

      {/* Existing Injected Directives History */}
      {directives.length > 0 && (
        <div className="space-y-2 bg-slate-50 border border-slate-200 rounded-lg p-3">
          <div className="text-xs font-semibold text-slate-700">
            已提交的实时补充与修正记录 ({directives.length})
          </div>
          <div className="space-y-1.5 max-h-36 overflow-y-auto">
            {directives.map((dir) => (
              <div
                key={dir.id}
                className="text-xs text-slate-700 flex flex-wrap items-start justify-between gap-2 py-1 border-b border-slate-200/70 last:border-b-0"
              >
                <div className="min-w-0 flex-1">
                  <span className="font-mono text-slate-500 tabular-nums mr-2">
                    {new Date(dir.createdAt).toLocaleTimeString('zh-CN', {
                      hour: '2-digit',
                      minute: '2-digit',
                      second: '2-digit',
                    })}
                  </span>
                  <span className="font-medium text-slate-800 mr-1.5">
                    [{dir.source === 'voice' ? '语音录入' : '文字补充'}]
                  </span>
                  <span>{dir.text || '（已上传补充参考文件）'}</span>
                  {dir.attachmentsMeta.length > 0 && (
                    <span className="text-blue-700 ml-1.5">
                      · 附件：{dir.attachmentsMeta.map((a) => a.name).join('、')}
                    </span>
                  )}
                </div>
                <span className="inline-flex items-center gap-1 text-[11px] font-mono tabular-nums shrink-0 text-emerald-700">
                  <CheckCircle2 className="w-3 h-3" aria-hidden="true" />
                  {dir.status === 'applied'
                    ? `已融合至第 ${dir.appliedBatchIndex || 1} 批`
                    : '已入队待下一轮续写融合'}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      <form onSubmit={handleSubmit} className="space-y-3">
        {/* Attachment Chips + Chunked Upload Progress */}
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
                  aria-label={`移除补充附件 ${att.name}`}
                  className="p-1 text-slate-400 hover:text-slate-700 rounded"
                >
                  <X className="w-3.5 h-3.5" aria-hidden="true" />
                </button>
              </div>
            ))}

            {uploadProgress && (
              <div className="flex items-center gap-2.5 px-3 py-1.5 bg-blue-50 border border-blue-200 rounded-lg text-xs text-blue-800">
                <Loader2 className="w-3.5 h-3.5 animate-spin text-blue-600 shrink-0" aria-hidden="true" />
                <span className="truncate max-w-[180px]">{uploadProgress.fileName}</span>
                <span className="font-mono tabular-nums font-semibold">
                  {uploadProgress.percent}% ({formatFileSize(uploadProgress.uploadedBytes)} /{' '}
                  {formatFileSize(uploadProgress.totalBytes)})
                </span>
              </div>
            )}
          </div>
        )}

        <div className="border border-slate-200 rounded-lg overflow-hidden bg-slate-50 focus-within:bg-white focus-within:border-blue-600">
          <label htmlFor="live-supplement-textarea" className="sr-only">
            在任务执行过程中输入补充或修正要求
          </label>
          <textarea
            id="live-supplement-textarea"
            rows={2}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onPaste={handlePaste}
            placeholder="随时新增或变更要求（如：「答案和解析另外输出一份独立文件」「改用中英双语符号」或粘贴 Google Drive 链接），系统将自动整合去重、动态调整后续轮次与分册且省 Token..."
            className="w-full px-3.5 py-2.5 text-sm text-slate-900 placeholder:text-slate-400 bg-transparent focus:outline-none leading-relaxed resize-y"
          />
          <LinkRecognitionBar
            text={text}
            driveToken={driveToken}
            onIngestedAttachments={(ingested) => {
              setAttachments((prev) => {
                const existingIds = new Set(prev.map((x) => x.serverFileId).filter(Boolean));
                return [
                  ...prev,
                  ...ingested.filter((x) => !x.serverFileId || !existingIds.has(x.serverFileId)),
                ];
              });
            }}
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
              id="supplement-unlimited-file-input"
            />
            <button
              type="button"
              disabled={Boolean(uploadProgress) || isSubmittingSupplement}
              onClick={() => fileInputRef.current?.click()}
              className="inline-flex items-center gap-2 px-3.5 py-2 text-xs font-medium text-slate-700 bg-white border border-slate-200 rounded-lg hover:bg-slate-100 disabled:opacity-50 transition-colors whitespace-nowrap shrink-0"
            >
              <Paperclip className="w-3.5 h-3.5 text-slate-500" aria-hidden="true" />
              <span>上传补充文件（不限大小）</span>
            </button>

            <VoiceDictationButton
              disabled={Boolean(uploadProgress) || isSubmittingSupplement}
              label="语音口述补充"
              onTranscribed={(spoken) => {
                setInputSource('voice');
                setText((prev) => (prev.trim() ? `${prev.trim()} ${spoken}` : spoken));
              }}
              onError={(err) => setLocalError(err)}
            />
          </div>

          <button
            type="submit"
            disabled={Boolean(uploadProgress) || isSubmittingSupplement}
            className="inline-flex items-center gap-2 px-4 py-2 text-xs font-semibold text-white bg-blue-600 rounded-lg hover:bg-blue-700 disabled:opacity-60 transition-colors whitespace-nowrap shrink-0"
          >
            {isSubmittingSupplement ? (
              <>
                <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" />
                <span>正在注入流水线...</span>
              </>
            ) : (
              <>
                <Send className="w-3.5 h-3.5" aria-hidden="true" />
                <span>{isJobRunning ? '无感注入补充要求' : '追加补充批次并更新云盘'}</span>
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
