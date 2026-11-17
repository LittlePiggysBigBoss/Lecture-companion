import type { AttachmentKind, ScannedLinkResult, UploadedAttachment } from '../types';
import { getAccessToken, getFirebaseIdToken } from './authDrive';

const CLIENT_DEVICE_KEY = 'carbon_client_device_id_v1';
const CHUNK_SIZE_BYTES = 8 * 1024 * 1024; // 8 MB binary chunks — zero file size cap!

export interface UploadProgressState {
  fileName: string;
  uploadedBytes: number;
  totalBytes: number;
  percent: number;
  fileIndex: number;
  totalFiles: number;
}

export function getClientDeviceId(): string {
  try {
    const existing = localStorage.getItem(CLIENT_DEVICE_KEY);
    if (existing) return existing;
    const generated = `dev-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    localStorage.setItem(CLIENT_DEVICE_KEY, generated);
    return generated;
  } catch {
    return 'dev-ephemeral';
  }
}

export async function buildAuthenticatedHeaders(
  explicitDriveToken?: string | null,
  jsonContentType = false
): Promise<Record<string, string>> {
  const headers: Record<string, string> = {
    'X-Client-Device-Id': getClientDeviceId(),
  };
  if (jsonContentType) {
    headers['Content-Type'] = 'application/json';
  }
  const driveTok = explicitDriveToken || getAccessToken();
  if (driveTok) {
    headers.Authorization = `Bearer ${driveTok}`;
  }
  const idToken = await getFirebaseIdToken();
  if (idToken) {
    headers['X-Firebase-Id-Token'] = idToken;
  }
  return headers;
}

export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

/**
 * Streams arbitrarily large files (e.g., 50MB, 500MB, 2GB+ PDFs, scans, images, DOCX, audio)
 * in 8 MB binary chunks to `/api/files/upload-*` with ZERO file-size restriction.
 */
export async function uploadFilesUnlimited(
  incomingFiles: FileList | File[],
  onProgress?: (state: UploadProgressState | null) => void
): Promise<UploadedAttachment[]> {
  const files = Array.from(incomingFiles);
  if (files.length === 0) return [];

  const totalBatchBytes = files.reduce((s, f) => s + f.size, 0);
  let completedPriorBytes = 0;
  const results: UploadedAttachment[] = [];

  try {
    for (let idx = 0; idx < files.length; idx++) {
      const file = files[idx];
      const initRes = await fetch('/api/files/upload-init', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          fileName: file.name,
          mimeType: file.type || 'application/octet-stream',
          totalSize: file.size,
        }),
      });
      const initData = (await initRes.json()) as { serverFileId?: string; error?: string };
      if (!initRes.ok || !initData.serverFileId) {
        throw new Error(initData.error || `初始化文件「${file.name}」上传失败`);
      }

      const serverFileId = initData.serverFileId;
      let offset = 0;

      if (file.size === 0) {
        onProgress?.({
          fileName: file.name,
          uploadedBytes: completedPriorBytes,
          totalBytes: Math.max(1, totalBatchBytes),
          percent: 100,
          fileIndex: idx + 1,
          totalFiles: files.length,
        });
      }

      while (offset < file.size) {
        const end = Math.min(offset + CHUNK_SIZE_BYTES, file.size);
        const sliceBlob = file.slice(offset, end);
        const chunkBuffer = await sliceBlob.arrayBuffer();

        const chunkRes = await fetch(
          `/api/files/upload-chunk?serverFileId=${encodeURIComponent(serverFileId)}`,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/octet-stream',
              'X-Upload-File-Id': serverFileId,
            },
            body: chunkBuffer,
          }
        );

        if (!chunkRes.ok) {
          const errJson = (await chunkRes.json().catch(() => ({}))) as { error?: string };
          throw new Error(errJson.error || `分片上传文件「${file.name}」中断`);
        }

        offset = end;
        const currentTotalUploaded = completedPriorBytes + offset;
        onProgress?.({
          fileName: file.name,
          uploadedBytes: currentTotalUploaded,
          totalBytes: Math.max(1, totalBatchBytes),
          percent: Math.min(100, Math.round((currentTotalUploaded / Math.max(1, totalBatchBytes)) * 100)),
          fileIndex: idx + 1,
          totalFiles: files.length,
        });
      }

      const finRes = await fetch('/api/files/upload-complete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ serverFileId }),
      });
      const finData = (await finRes.json()) as {
        serverFileId?: string;
        fileName?: string;
        mimeType?: string;
        kind?: AttachmentKind;
        size?: number;
        error?: string;
      };
      if (!finRes.ok || !finData.serverFileId) {
        throw new Error(finData.error || `合并校验文件「${file.name}」失败`);
      }

      completedPriorBytes += file.size;

      const previewUrl =
        finData.kind === 'image' && file.size <= 25 * 1024 * 1024
          ? URL.createObjectURL(file)
          : undefined;

      results.push({
        id: `att-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        name: finData.fileName || file.name,
        mimeType: finData.mimeType || file.type || 'application/octet-stream',
        size: finData.size ?? file.size,
        kind: finData.kind || 'binary',
        serverFileId: finData.serverFileId,
        previewUrl,
      });
    }

    return results;
  } finally {
    onProgress?.(null);
  }
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const str = String(reader.result || '');
      const comma = str.indexOf(',');
      resolve(comma >= 0 ? str.slice(comma + 1) : str);
    };
    reader.onerror = () => reject(new Error('读取语音音频失败'));
    reader.readAsDataURL(blob);
  });
}

export async function transcribeVoiceBlob(blob: Blob, mimeType: string): Promise<string> {
  const base64Audio = await blobToBase64(blob);
  const res = await fetch('/api/audio/transcribe', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      base64Audio,
      mimeType: mimeType || blob.type || 'audio/webm',
    }),
  });
  const data = (await res.json()) as { text?: string; error?: string };
  if (!res.ok) {
    throw new Error(data.error || '语音转写失败');
  }
  return (data.text || '').trim();
}

export async function scanInputLinksClient(params: {
  rawText: string;
  driveToken?: string | null;
  forceRefresh?: boolean;
}): Promise<{
  scannedLinks: ScannedLinkResult[];
  attachments: UploadedAttachment[];
}> {
  const headers = await buildAuthenticatedHeaders(params.driveToken, true);
  const res = await fetch('/api/links/scan', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      rawText: params.rawText,
      forceRefresh: Boolean(params.forceRefresh),
    }),
  });
  const data = (await res.json()) as {
    scannedLinks?: ScannedLinkResult[];
    ingestedAttachments?: Array<{
      name: string;
      mimeType: string;
      kind: AttachmentKind;
      size?: number;
      serverFileId?: string;
      extractedText?: string;
    }>;
    error?: string;
  };
  if (!res.ok) {
    throw new Error(data.error || '解析链接失败');
  }

  const mappedAttachments: UploadedAttachment[] = (data.ingestedAttachments || []).map(
    (item, idx) => ({
      id: `link-att-${item.serverFileId || idx}-${Date.now()}`,
      name: item.name,
      mimeType: item.mimeType,
      size: item.size || 0,
      kind: item.kind,
      serverFileId: item.serverFileId,
      extractedText: item.extractedText,
    })
  );

  return {
    scannedLinks: data.scannedLinks || [],
    attachments: mappedAttachments,
  };
}
