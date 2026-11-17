import fs from 'node:fs';
import path from 'node:path';
import { GoogleGenAI } from '@google/genai';
import mammoth from 'mammoth';
import type { AttachmentKind } from '../types.ts';

const DATA_DIR = path.resolve(process.cwd(), '.carbon-jobs');
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
const UPLOAD_META_FILE = path.join(DATA_DIR, 'uploads_meta.json');

export const TRANSCRIBE_MODEL = 'gemini-3.5-transcribe';

export interface StoredServerUpload {
  serverFileId: string;
  fileName: string;
  mimeType: string;
  kind: AttachmentKind;
  size: number;
  diskPath: string;
  extractedText?: string;
  geminiFileUri?: string;
  geminiFileExpiresAtMs?: number;
  createdAt: string;
}

const uploadRegistry = new Map<string, StoredServerUpload>();

function ensureUploadDir(): void {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

function persistUploadMeta(): void {
  try {
    ensureUploadDir();
    const list = Array.from(uploadRegistry.values());
    const tmp = `${UPLOAD_META_FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(list, null, 2), 'utf-8');
    fs.renameSync(tmp, UPLOAD_META_FILE);
  } catch {
    // Ignore
  }
}

export function loadUploadRegistryFromDisk(): void {
  try {
    ensureUploadDir();
    if (!fs.existsSync(UPLOAD_META_FILE)) return;
    const list = JSON.parse(fs.readFileSync(UPLOAD_META_FILE, 'utf-8')) as StoredServerUpload[];
    if (!Array.isArray(list)) return;
    for (const item of list) {
      if (item.serverFileId && fs.existsSync(item.diskPath)) {
        uploadRegistry.set(item.serverFileId, item);
      }
    }
  } catch {
    // Ignore
  }
}

function getGenAIClient(): GoogleGenAI {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error(
      '未检测到 GEMINI_API_KEY。请在 Settings > Secrets 中关联您的付费 API Key。'
    );
  }
  return new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });
}

export function inferAttachmentKind(fileName: string, mimeType: string): AttachmentKind {
  const lower = fileName.toLowerCase();
  const mime = (mimeType || '').toLowerCase();
  if (mime.startsWith('image/') || /\.(png|jpe?g|webp|gif|bmp|svg)$/.test(lower)) {
    return 'image';
  }
  if (mime === 'application/pdf' || lower.endsWith('.pdf')) {
    return 'pdf';
  }
  if (
    lower.endsWith('.docx') ||
    mime === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  ) {
    return 'docx';
  }
  if (mime.startsWith('audio/') || /\.(mp3|wav|webm|m4a|ogg|flac)$/.test(lower)) {
    return 'audio';
  }
  if (
    mime.startsWith('text/') ||
    /\.(txt|md|markdown|tex|csv|tsv|json|py|ts|js|html|xml|yaml|yml)$/.test(lower)
  ) {
    return 'text';
  }
  return 'binary';
}

export function initChunkedUpload(params: {
  fileName: string;
  mimeType: string;
  totalSize: number;
}): { serverFileId: string } {
  ensureUploadDir();
  const serverFileId = `up-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const safeExt = path.extname(params.fileName).replace(/[^a-zA-Z0-9.]/g, '').slice(0, 10);
  const diskPath = path.join(UPLOAD_DIR, `${serverFileId}${safeExt}`);
  fs.writeFileSync(diskPath, Buffer.alloc(0));

  const kind = inferAttachmentKind(params.fileName, params.mimeType);
  uploadRegistry.set(serverFileId, {
    serverFileId,
    fileName: params.fileName,
    mimeType: params.mimeType || 'application/octet-stream',
    kind,
    size: params.totalSize || 0,
    diskPath,
    createdAt: new Date().toISOString(),
  });
  return { serverFileId };
}

export function appendUploadChunk(serverFileId: string, chunkBuffer: Buffer): { receivedBytes: number } {
  const meta = uploadRegistry.get(serverFileId);
  if (!meta) {
    throw new Error('上传会话不存在或已过期，请重新选择文件上传。');
  }
  fs.appendFileSync(meta.diskPath, chunkBuffer);
  const stat = fs.statSync(meta.diskPath);
  meta.size = stat.size;
  return { receivedBytes: stat.size };
}

export async function finalizeChunkedUpload(serverFileId: string): Promise<{
  serverFileId: string;
  fileName: string;
  mimeType: string;
  kind: AttachmentKind;
  size: number;
  extractedTextPreview?: string;
}> {
  const meta = uploadRegistry.get(serverFileId);
  if (!meta || !fs.existsSync(meta.diskPath)) {
    throw new Error('未找到对应的上传文件数据。');
  }

  const stat = fs.statSync(meta.diskPath);
  meta.size = stat.size;

  if (meta.kind === 'docx') {
    try {
      const result = await mammoth.extractRawText({ path: meta.diskPath });
      meta.extractedText = (result.value || '').trim();
    } catch (err) {
      console.warn('Mammoth DOCX parse warning:', err);
    }
  } else if (meta.kind === 'text' && meta.size <= 2 * 1024 * 1024) {
    meta.extractedText = fs.readFileSync(meta.diskPath, 'utf-8');
  }

  persistUploadMeta();

  return {
    serverFileId: meta.serverFileId,
    fileName: meta.fileName,
    mimeType: meta.mimeType,
    kind: meta.kind,
    size: meta.size,
    extractedTextPreview: meta.extractedText ? meta.extractedText.slice(0, 500) : undefined,
  };
}

export function getStoredServerUpload(serverFileId: string): StoredServerUpload | undefined {
  return uploadRegistry.get(serverFileId);
}

/**
 * Registers an in-memory Buffer (e.g. downloaded from a Google Drive link, Google Docs export,
 * arXiv PDF, or scraped web resource) into the unlimited file store so Gemini 4 Carbon
 * can natively scan its pages/formulas/diagrams via inlineData or Gemini Files API.
 */
export async function registerBufferAsServerUpload(params: {
  fileName: string;
  mimeType: string;
  buffer: Buffer;
  overrideExtractedText?: string;
}): Promise<StoredServerUpload> {
  ensureUploadDir();
  const serverFileId = `link-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const safeExt = path.extname(params.fileName).replace(/[^a-zA-Z0-9.]/g, '').slice(0, 10);
  const diskPath = path.join(UPLOAD_DIR, `${serverFileId}${safeExt}`);
  fs.writeFileSync(diskPath, params.buffer);

  const kind = inferAttachmentKind(params.fileName, params.mimeType);
  const entry: StoredServerUpload = {
    serverFileId,
    fileName: params.fileName,
    mimeType: params.mimeType || 'application/octet-stream',
    kind,
    size: params.buffer.length,
    diskPath,
    createdAt: new Date().toISOString(),
  };

  if (params.overrideExtractedText !== undefined) {
    entry.extractedText = params.overrideExtractedText;
  } else if (kind === 'docx') {
    try {
      const result = await mammoth.extractRawText({ buffer: params.buffer });
      entry.extractedText = (result.value || '').trim();
    } catch {
      // Non-fatal DOCX parse warning
    }
  } else if (kind === 'text' && params.buffer.length <= 2 * 1024 * 1024) {
    entry.extractedText = params.buffer.toString('utf-8');
  }

  uploadRegistry.set(serverFileId, entry);
  persistUploadMeta();
  return entry;
}

/**
 * Converts a stored unlimited-size server file into a Gemini multimodal Content Part:
 * - Extracted text (.docx / .txt / .md / .tex) -> { text }
 * - Files <= 10 MB -> { inlineData }
 * - Large / Unlimited-Size Files (> 10 MB, e.g. 50MB - 2GB PDFs, scans, audio, video)
 *   -> Automatically uploads via Gemini Files API (`ai.files.upload`) and returns `{ fileData: { fileUri, mimeType } }`!
 */
export async function resolveStoredFileToGeminiPart(
  serverFileId: string
): Promise<Record<string, unknown> | null> {
  const meta = uploadRegistry.get(serverFileId);
  if (!meta || !fs.existsSync(meta.diskPath)) return null;

  if (meta.extractedText !== undefined) {
    return {
      text: `\n--- 参考附件文档 (${meta.fileName}) 开始 ---\n${meta.extractedText}\n--- 参考附件文档 (${meta.fileName}) 结束 ---\n`,
    };
  }

  const INLINE_THRESHOLD_BYTES = 10 * 1024 * 1024; // 10 MB
  if (
    meta.size <= INLINE_THRESHOLD_BYTES &&
    (meta.kind === 'image' || meta.kind === 'pdf' || meta.kind === 'audio')
  ) {
    const b64 = fs.readFileSync(meta.diskPath).toString('base64');
    return {
      inlineData: {
        mimeType: meta.mimeType,
        data: b64,
      },
    };
  }

  // Reuse valid Gemini Files API URI if uploaded within the last 40 hours (Gemini Files TTL is 48h)
  const nowMs = Date.now();
  if (
    meta.geminiFileUri &&
    meta.geminiFileExpiresAtMs &&
    meta.geminiFileExpiresAtMs > nowMs
  ) {
    return {
      fileData: {
        fileUri: meta.geminiFileUri,
        mimeType: meta.mimeType === 'application/octet-stream' ? 'text/plain' : meta.mimeType,
      },
    };
  }

  // Upload arbitrarily large file to Gemini Files API from disk!
  const ai = getGenAIClient();
  const effectiveMime =
    meta.mimeType === 'application/octet-stream' ? 'text/plain' : meta.mimeType;

  const uploaded = await ai.files.upload({
    file: meta.diskPath,
    config: {
      mimeType: effectiveMime,
      displayName: meta.fileName,
    },
  });

  let fileState = uploaded.state;
  let fileNameResource = uploaded.name || '';
  let fileUri = uploaded.uri || '';

  // Poll briefly if file is still PROCESSING (e.g. large PDF or audio/video)
  let pollCount = 0;
  while (fileState === 'PROCESSING' && fileNameResource && pollCount < 30) {
    await new Promise((r) => setTimeout(r, 2000));
    const fetched = await ai.files.get({ name: fileNameResource });
    fileState = fetched.state;
    fileUri = fetched.uri || fileUri;
    pollCount += 1;
  }

  if (!fileUri) {
    throw new Error(`大文件「${meta.fileName}」上传至 Gemini Files 云端解析失败。`);
  }

  meta.geminiFileUri = fileUri;
  meta.geminiFileExpiresAtMs = nowMs + 40 * 3600 * 1000;
  persistUploadMeta();

  return {
    fileData: {
      fileUri,
      mimeType: effectiveMime,
    },
  };
}

/**
 * Transcribes spoken voice recording into clean academic Chinese/English prompt text
 * using `gemini-3.5-transcribe`.
 */
export async function transcribeVoiceDictationServer(params: {
  base64Audio: string;
  mimeType: string;
}): Promise<string> {
  const ai = getGenAIClient();
  const response = await ai.models.generateContent({
    model: TRANSCRIBE_MODEL,
    contents: {
      parts: [
        {
          inlineData: {
            mimeType: params.mimeType || 'audio/webm',
            data: params.base64Audio,
          },
        },
        {
          text: '请准确转写这段语音指令（可能包含中文教学要求以及英文数学/物理/计算机专业术语或竞赛名如 PhysicsBowl, F=ma, BPhO, KKT, LaTeX 等）。只输出转写后的纯文本，加上规范标点，不要输出任何额外解释。',
        },
      ],
    },
  });

  return (response.text || '').trim();
}
