import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertCircle,
  CheckCircle2,
  ExternalLink,
  Link2,
  Loader2,
  RefreshCw,
} from 'lucide-react';
import type {
  RecognizedLinkKind,
  ScannedLinkResult,
  UploadedAttachment,
} from '../types';
import { formatFileSize, scanInputLinksClient } from '../services/fileAndVoiceClient';
import { extractRecognizedLinks } from '../utils/linkAndMemoryLogic';

interface LinkRecognitionBarProps {
  text: string;
  driveToken?: string | null;
  onIngestedAttachments: (newAttachments: UploadedAttachment[]) => void;
  onScannedLinksChange?: (links: ScannedLinkResult[]) => void;
}

function formatLinkKindLabel(kind: RecognizedLinkKind): string {
  switch (kind) {
    case 'google_drive_file':
      return 'Google Drive 云盘文件';
    case 'google_drive_folder':
      return 'Google Drive 云盘文件夹';
    case 'google_doc':
      return 'Google Docs 文档';
    case 'google_slides':
      return 'Google Slides 课件';
    case 'google_sheets':
      return 'Google Sheets 表格';
    case 'arxiv_paper':
      return 'arXiv 论文 PDF';
    case 'direct_document':
      return '直链学术文档';
    case 'web_page':
    default:
      return '网页正文抓取';
  }
}

export const LinkRecognitionBar: React.FC<LinkRecognitionBarProps> = ({
  text,
  driveToken,
  onIngestedAttachments,
  onScannedLinksChange,
}) => {
  const recognized = useMemo(() => extractRecognizedLinks(text), [text]);
  const [scannedMap, setScannedMap] = useState<Record<string, ScannedLinkResult>>({});
  const [isScanning, setIsScanning] = useState(false);
  const [scanError, setScanError] = useState<string | null>(null);

  const ingestedServerFileIdsRef = useRef<Set<string>>(new Set());
  const inFlightSignatureRef = useRef<string>('');
  const hadNonEmptyLinksRef = useRef(false);
  const onIngestedRef = useRef(onIngestedAttachments);
  const onScannedChangeRef = useRef(onScannedLinksChange);
  onIngestedRef.current = onIngestedAttachments;
  onScannedChangeRef.current = onScannedLinksChange;

  const runScan = useCallback(
    async (forceRefresh = false) => {
      if (recognized.length === 0) return;
      const signature = recognized.map((r) => r.url).join('|');
      if (!forceRefresh && inFlightSignatureRef.current === signature) return;
      inFlightSignatureRef.current = signature;

      setIsScanning(true);
      setScanError(null);
      try {
        const { scannedLinks, attachments } = await scanInputLinksClient({
          rawText: recognized.map((r) => r.url).join('\n'),
          driveToken,
          forceRefresh,
        });

        setScannedMap((prev) => {
          const next = { ...prev };
          for (const item of scannedLinks) {
            next[item.url] = item;
          }
          onScannedChangeRef.current?.(
            recognized.map((r) => next[r.url]).filter((x): x is ScannedLinkResult => Boolean(x))
          );
          return next;
        });

        const freshAttachments = attachments.filter((att) => {
          if (!att.serverFileId) return true;
          if (ingestedServerFileIdsRef.current.has(att.serverFileId)) return false;
          ingestedServerFileIdsRef.current.add(att.serverFileId);
          return true;
        });

        if (freshAttachments.length > 0) {
          onIngestedRef.current(freshAttachments);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        setScanError(msg);
      } finally {
        setIsScanning(false);
      }
    },
    [driveToken, recognized]
  );

  // Auto-detect & scan debounced whenever new links appear in the input box
  useEffect(() => {
    if (recognized.length === 0) {
      inFlightSignatureRef.current = '';
      if (hadNonEmptyLinksRef.current) {
        hadNonEmptyLinksRef.current = false;
        onScannedChangeRef.current?.([]);
      }
      return;
    }
    hadNonEmptyLinksRef.current = true;
    const hasUnscanned = recognized.some((r) => !scannedMap[r.url]);
    if (!hasUnscanned) return;

    const timer = window.setTimeout(() => {
      void runScan(false);
    }, 650);

    return () => window.clearTimeout(timer);
  }, [recognized, runScan, scannedMap]);

  if (recognized.length === 0) {
    return null;
  }

  return (
    <div className="px-4 py-3 bg-slate-50/80 border-t border-slate-200 space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-xs text-slate-700">
          <Link2 className="w-3.5 h-3.5 text-blue-600 shrink-0" aria-hidden="true" />
          <span className="font-semibold text-slate-900">
            已自动识别 {recognized.length} 个云盘/文件/网页链接
          </span>
          <span aria-hidden="true" className="text-slate-400">
            ·
          </span>
          <span className="text-slate-500">
            {isScanning
              ? '正在自动抓取并多模态扫描链接内容...'
              : '已自动抓取并挂载至长上下文多模态输入'}
          </span>
        </div>

        <button
          type="button"
          disabled={isScanning}
          onClick={() => void runScan(true)}
          className="inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium text-slate-700 bg-white border border-slate-200 rounded-md hover:bg-slate-100 disabled:opacity-50 transition-colors whitespace-nowrap shrink-0"
        >
          <RefreshCw
            className={`w-3 h-3 text-slate-500 ${isScanning ? 'animate-spin' : ''}`}
            aria-hidden="true"
          />
          <span>重新扫描抓取</span>
        </button>
      </div>

      <div className="divide-y divide-slate-200/80 border border-slate-200 rounded-lg bg-white">
        {recognized.map((desc) => {
          const scanned = scannedMap[desc.url];
          return (
            <div
              key={desc.url}
              className="px-3 py-2 text-xs flex flex-col sm:flex-row sm:items-center justify-between gap-1.5"
            >
              <div className="flex items-start sm:items-center gap-2 min-w-0 flex-1">
                {!scanned || isScanning ? (
                  <Loader2
                    className="w-3.5 h-3.5 animate-spin text-blue-600 shrink-0 mt-0.5 sm:mt-0"
                    aria-hidden="true"
                  />
                ) : scanned.status === 'ready' ? (
                  <CheckCircle2
                    className="w-3.5 h-3.5 text-emerald-600 shrink-0 mt-0.5 sm:mt-0"
                    aria-hidden="true"
                  />
                ) : (
                  <AlertCircle
                    className="w-3.5 h-3.5 text-amber-600 shrink-0 mt-0.5 sm:mt-0"
                    aria-hidden="true"
                  />
                )}

                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-1.5 text-slate-800">
                    <span className="font-semibold truncate max-w-[320px]">
                      {scanned?.title || desc.displayLabel}
                    </span>
                    <span aria-hidden="true" className="text-slate-400">
                      ·
                    </span>
                    <span className="text-slate-500">{formatLinkKindLabel(desc.kind)}</span>
                    {scanned?.size ? (
                      <>
                        <span aria-hidden="true" className="text-slate-400">
                          ·
                        </span>
                        <span className="font-mono tabular-nums text-slate-500">
                          {formatFileSize(scanned.size)}
                        </span>
                      </>
                    ) : null}
                  </div>

                  {scanned?.errorMessage && (
                    <p className="text-[11px] text-amber-700 mt-0.5 leading-snug">
                      {scanned.errorMessage}
                    </p>
                  )}
                </div>
              </div>

              <div className="flex items-center gap-2 shrink-0 font-mono text-[11px] tabular-nums">
                {scanned?.status === 'ready' ? (
                  <span className="text-emerald-700 font-sans font-medium">
                    已扫描挂载为多模态附件
                  </span>
                ) : !scanned && isScanning ? (
                  <span className="text-blue-700 font-sans">正在抓取解析...</span>
                ) : (
                  <span className="text-amber-700 font-sans">待权限/URL直读</span>
                )}
                <a
                  href={desc.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  aria-label={`在新窗口查看原链接 ${desc.displayLabel}`}
                  className="text-slate-400 hover:text-blue-600 p-0.5"
                >
                  <ExternalLink className="w-3 h-3" aria-hidden="true" />
                </a>
              </div>
            </div>
          );
        })}
      </div>

      {scanError && (
        <p className="text-[11px] text-amber-700">
          链接预扫描提示：{scanError}（提交任务时服务端将自动重试抓取）
        </p>
      )}
    </div>
  );
};
