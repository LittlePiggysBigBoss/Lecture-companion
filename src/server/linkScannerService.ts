import { execFile } from 'node:child_process';
import fs from 'node:fs';
import { promisify } from 'node:util';
import type {
  AttachmentSummary,
  ScannedLinkResult,
} from '../types.ts';
import type { RecognizedLinkDescriptor } from '../utils/linkAndMemoryLogic.ts';
import { extractRecognizedLinks } from '../utils/linkAndMemoryLogic.ts';
import { registerBufferAsServerUpload } from './unlimitedFileStore.ts';
import type { ServerAttachmentPayload } from './cloudJobRunner.ts';

const execFileAsync = promisify(execFile);

const BROWSER_USER_AGENT =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

interface CachedScanRecord {
  expiresAtMs: number;
  result: ScannedLinkResult;
  attachments: ServerAttachmentPayload[];
}

const scanCache = new Map<string, CachedScanRecord>();
const CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes

function findChromiumBin(): string | null {
  const candidates = [
    process.env.CHROMIUM_PATH,
    '/ms-playwright/chrome-headless-shell-linux64/chrome-headless-shell',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ].filter(Boolean) as string[];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return null;
}

export function isGoogleAuthWall(finalUrl: string, htmlStr: string): boolean {
  if (/accounts\.google\.com/i.test(finalUrl)) return true;
  const sample = htmlStr.slice(0, 14_000);
  return (
    /accounts\.google\.com\/(ServiceLogin|v3\/signin|signin)/i.test(sample) ||
    /Google Drive:\s*Sign-in/i.test(sample) ||
    /Sign in\s*-\s*Google Accounts/i.test(sample) ||
    /登录\s*-\s*Google\s*账号/i.test(sample) ||
    /You need access|Request access|需要访问权限|请求访问权限/i.test(sample)
  );
}

function parseContentDispositionFileName(headerVal: string | null): string | null {
  if (!headerVal) return null;
  const utf8Match = headerVal.match(/filename\*\s*=\s*UTF-8''([^;\r\n]+)/i);
  if (utf8Match?.[1]) {
    try {
      return decodeURIComponent(utf8Match[1].trim().replace(/^["']|["']$/g, ''));
    } catch {
      return utf8Match[1].trim();
    }
  }
  const plainMatch = headerVal.match(/filename\s*=\s*"([^"]+)"|filename\s*=\s*([^;\r\n]+)/i);
  const raw = plainMatch?.[1] || plainMatch?.[2];
  if (!raw) return null;
  try {
    return decodeURIComponent(raw.trim().replace(/^["']|["']$/g, ''));
  } catch {
    return raw.trim().replace(/^["']|["']$/g, '');
  }
}

function sniffBufferMimeAndExtension(
  buf: Buffer,
  declaredMime: string,
  fallbackName: string
): { mimeType: string; fileName: string; isHtmlPage: boolean } {
  const cleanMime = (declaredMime || '').split(';')[0].trim().toLowerCase();
  const headAscii = buf.subarray(0, 64).toString('latin1');
  const headUtf8 = buf.subarray(0, 512).toString('utf-8').trimStart();

  // Magic bytes: PDF (%PDF-)
  if (headAscii.startsWith('%PDF-') || cleanMime === 'application/pdf') {
    const fn = fallbackName.toLowerCase().endsWith('.pdf') ? fallbackName : `${fallbackName}.pdf`;
    return { mimeType: 'application/pdf', fileName: fn, isHtmlPage: false };
  }

  // Magic bytes: PNG
  if (buf.length > 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    const fn = /\.(png)$/i.test(fallbackName) ? fallbackName : `${fallbackName}.png`;
    return { mimeType: 'image/png', fileName: fn, isHtmlPage: false };
  }

  // Magic bytes: JPEG
  if (buf.length > 4 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    const fn = /\.(jpe?g)$/i.test(fallbackName) ? fallbackName : `${fallbackName}.jpg`;
    return { mimeType: 'image/jpeg', fileName: fn, isHtmlPage: false };
  }

  // Magic bytes: ZIP / DOCX (PK\x03\x04)
  if (
    buf.length > 4 &&
    buf[0] === 0x50 &&
    buf[1] === 0x4b &&
    (cleanMime.includes('wordprocessingml') || fallbackName.toLowerCase().endsWith('.docx'))
  ) {
    const fn = fallbackName.toLowerCase().endsWith('.docx') ? fallbackName : `${fallbackName}.docx`;
    return {
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      fileName: fn,
      isHtmlPage: false,
    };
  }

  const looksHtml =
    cleanMime === 'text/html' ||
    /^<!doctype\s+html/i.test(headUtf8) ||
    /^<html[\s>]/i.test(headUtf8);

  if (looksHtml) {
    return { mimeType: 'text/html', fileName: fallbackName, isHtmlPage: true };
  }

  if (cleanMime.startsWith('text/') || cleanMime === 'application/json') {
    const ext = cleanMime.includes('csv') ? '.csv' : cleanMime.includes('markdown') ? '.md' : '.txt';
    const fn = /\.[a-z0-9]{2,5}$/i.test(fallbackName) ? fallbackName : `${fallbackName}${ext}`;
    return { mimeType: cleanMime || 'text/plain', fileName: fn, isHtmlPage: false };
  }

  return {
    mimeType: cleanMime || 'application/octet-stream',
    fileName: fallbackName,
    isHtmlPage: false,
  };
}

function decodeHtmlEntities(str: string): string {
  return str
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)));
}

export function extractCleanTextFromHtml(html: string): {
  title: string;
  description: string;
  bodyText: string;
} {
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const ogTitleMatch = html.match(
    /<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i
  );
  const descMatch = html.match(
    /<meta[^>]+(?:name|property)=["'](?:description|og:description)["'][^>]+content=["']([^"']+)["']/i
  );

  const title = decodeHtmlEntities((ogTitleMatch?.[1] || titleMatch?.[1] || '').trim()).replace(
    /\s+/g,
    ' '
  );
  const description = decodeHtmlEntities((descMatch?.[1] || '').trim()).replace(/\s+/g, ' ');

  const stripped = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<svg[\s\S]*?<\/svg>/gi, ' ')
    .replace(/<\/(p|div|section|article|li|tr|h1|h2|h3|h4|h5|h6|br|blockquote|pre)>/gi, '\n')
    .replace(/<h1[^>]*>/gi, '\n# ')
    .replace(/<h2[^>]*>/gi, '\n## ')
    .replace(/<h3[^>]*>/gi, '\n### ')
    .replace(/<li[^>]*>/gi, '\n- ')
    .replace(/<[^>]+>/g, ' ');

  const bodyText = decodeHtmlEntities(stripped)
    .split('\n')
    .map((line) => line.replace(/[ \t]+/g, ' ').trim())
    .filter((line) => line.length > 0)
    .join('\n')
    .slice(0, 90_000);

  return { title, description, bodyText };
}

async function renderDomViaHeadlessChromium(url: string): Promise<string | null> {
  const bin = findChromiumBin();
  if (!bin) return null;
  try {
    const { stdout } = await execFileAsync(
      bin,
      [
        '--headless',
        '--no-sandbox',
        '--disable-gpu',
        '--disable-dev-shm-usage',
        '--disable-extensions',
        '--no-first-run',
        '--log-level=3',
        '--virtual-time-budget=4500',
        '--dump-dom',
        url,
      ],
      {
        timeout: 18_000,
        maxBuffer: 15 * 1024 * 1024,
        env: {
          ...process.env,
          DBUS_SESSION_BUS_ADDRESS: 'disabled:',
          DBUS_SYSTEM_BUS_ADDRESS: 'disabled:',
        },
      }
    );
    return stdout || null;
  } catch {
    return null;
  }
}

/**
 * Attempts to resolve a Google Drive virus-scan confirmation HTML page (`download-form`)
 * into the actual binary file stream.
 */
async function followGoogleDriveConfirmFormIfPresent(html: string): Promise<{
  buffer: Buffer;
  contentType: string;
  fileName: string | null;
} | null> {
  const actionMatch = html.match(/<form[^>]+id=["']download-form["'][^>]+action=["']([^"']+)["']/i);
  if (!actionMatch?.[1]) return null;

  const actionUrl = new URL(decodeHtmlEntities(actionMatch[1]));
  const inputMatches = html.matchAll(
    /<input[^>]+type=["']hidden["'][^>]+name=["']([^"']+)["'][^>]+value=["']([^"']*)["']/gi
  );
  for (const m of inputMatches) {
    actionUrl.searchParams.set(m[1], decodeHtmlEntities(m[2]));
  }

  const res = await fetch(actionUrl.toString(), {
    headers: { 'User-Agent': BROWSER_USER_AGENT },
    redirect: 'follow',
    signal: AbortSignal.timeout(35_000),
  });
  if (!res.ok) return null;
  const ab = await res.arrayBuffer();
  return {
    buffer: Buffer.from(ab),
    contentType: res.headers.get('content-type') || 'application/octet-stream',
    fileName: parseContentDispositionFileName(res.headers.get('content-disposition')),
  };
}

async function fetchGoogleDriveSingleFile(params: {
  fileId: string;
  originalUrl: string;
  driveToken?: string | null;
  fallbackTitle?: string;
}): Promise<{
  result: ScannedLinkResult;
  attachments: ServerAttachmentPayload[];
}> {
  const { fileId, originalUrl, driveToken, fallbackTitle } = params;
  const nowIso = new Date().toISOString();

  // Path A: Try authenticated Google Drive API v3 if user token has access
  if (driveToken) {
    try {
      const metaRes = await fetch(
        `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?fields=id,name,mimeType,size&supportsAllDrives=true`,
        {
          headers: { Authorization: `Bearer ${driveToken}` },
          signal: AbortSignal.timeout(12_000),
        }
      );
      if (metaRes.ok) {
        const meta = (await metaRes.json()) as {
          id: string;
          name?: string;
          mimeType?: string;
          size?: string;
        };
        const gMime = meta.mimeType || 'application/octet-stream';
        let downloadRes: Response;
        let resolvedMime = gMime;
        let resolvedName = meta.name || fallbackTitle || `Drive_${fileId.slice(0, 8)}`;

        if (gMime === 'application/vnd.google-apps.document') {
          resolvedMime = 'application/pdf';
          if (!resolvedName.toLowerCase().endsWith('.pdf')) resolvedName += '.pdf';
          downloadRes = await fetch(
            `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}/export?mimeType=application/pdf`,
            {
              headers: { Authorization: `Bearer ${driveToken}` },
              signal: AbortSignal.timeout(30_000),
            }
          );
        } else if (gMime === 'application/vnd.google-apps.presentation') {
          resolvedMime = 'application/pdf';
          if (!resolvedName.toLowerCase().endsWith('.pdf')) resolvedName += '.pdf';
          downloadRes = await fetch(
            `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}/export?mimeType=application/pdf`,
            {
              headers: { Authorization: `Bearer ${driveToken}` },
              signal: AbortSignal.timeout(30_000),
            }
          );
        } else if (gMime === 'application/vnd.google-apps.spreadsheet') {
          resolvedMime = 'text/csv';
          if (!resolvedName.toLowerCase().endsWith('.csv')) resolvedName += '.csv';
          downloadRes = await fetch(
            `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}/export?mimeType=text/csv`,
            {
              headers: { Authorization: `Bearer ${driveToken}` },
              signal: AbortSignal.timeout(25_000),
            }
          );
        } else {
          downloadRes = await fetch(
            `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?alt=media&supportsAllDrives=true`,
            {
              headers: { Authorization: `Bearer ${driveToken}` },
              signal: AbortSignal.timeout(45_000),
            }
          );
        }

        if (downloadRes.ok) {
          const buf = Buffer.from(await downloadRes.arrayBuffer());
          const sniffed = sniffBufferMimeAndExtension(buf, resolvedMime, resolvedName);
          const stored = await registerBufferAsServerUpload({
            fileName: sniffed.fileName,
            mimeType: sniffed.mimeType,
            buffer: buf,
          });
          const attPayload: ServerAttachmentPayload = {
            name: stored.fileName,
            mimeType: stored.mimeType,
            kind: stored.kind,
            size: stored.size,
            serverFileId: stored.serverFileId,
            extractedText: stored.extractedText,
          };
          return {
            result: {
              url: originalUrl,
              normalizedFetchUrl: `https://drive.google.com/file/d/${fileId}/view`,
              kind: 'google_drive_file',
              resourceId: fileId,
              status: 'ready',
              title: stored.fileName,
              mimeType: stored.mimeType,
              size: stored.size,
              serverFileId: stored.serverFileId,
              attachmentKind: stored.kind,
              extractedPreview: stored.extractedText?.slice(0, 1200),
              scannedAt: nowIso,
            },
            attachments: [attPayload],
          };
        }
      }
    } catch {
      // Fall through to Path B public link download
    }
  }

  // Path B: Public / Shared "Anyone with the link" direct download endpoints
  const candidateUrls = [
    `https://drive.usercontent.google.com/download?id=${encodeURIComponent(fileId)}&export=download&confirm=t`,
    `https://drive.google.com/uc?export=download&id=${encodeURIComponent(fileId)}&confirm=t`,
  ];

  for (const dlUrl of candidateUrls) {
    try {
      const res = await fetch(dlUrl, {
        headers: { 'User-Agent': BROWSER_USER_AGENT },
        redirect: 'follow',
        signal: AbortSignal.timeout(35_000),
      });
      if (!res.ok) continue;

      let buf: Buffer = Buffer.from(await res.arrayBuffer());
      let contentType = res.headers.get('content-type') || 'application/octet-stream';
      let dispName = parseContentDispositionFileName(res.headers.get('content-disposition'));

      const initialSniff = sniffBufferMimeAndExtension(
        buf,
        contentType,
        dispName || fallbackTitle || `Drive_${fileId.slice(0, 10)}`
      );

      if (initialSniff.isHtmlPage) {
        const htmlStr = buf.toString('utf-8');
        // Check if this is Google's large-file virus scan confirmation form
        const confirmed = await followGoogleDriveConfirmFormIfPresent(htmlStr);
        if (confirmed) {
          buf = confirmed.buffer;
          contentType = confirmed.contentType;
          dispName = confirmed.fileName || dispName;
        } else {
          // Check if it's a Google Sign-In wall (private file without public link sharing)
          if (isGoogleAuthWall(res.url || dlUrl, htmlStr)) {
            return {
              result: {
                url: originalUrl,
                normalizedFetchUrl: dlUrl,
                kind: 'google_drive_file',
                resourceId: fileId,
                status: 'warning',
                title: fallbackTitle || `云盘受限文件 (${fileId.slice(0, 10)}...)`,
                errorMessage:
                  '该 Google Drive 链接当前未开启公开共享，请将其共享权限设为「知道链接的任何人可查看」或直接拖入本地副本。',
                scannedAt: nowIso,
              },
              attachments: [],
            };
          }
          // Otherwise try extracting Drive viewer title/metadata if public preview page
          const parsedHtml = extractCleanTextFromHtml(htmlStr);
          if (parsedHtml.bodyText.length > 200) {
            const cleanTitle =
              (parsedHtml.title || fallbackTitle || `Drive_${fileId.slice(0, 8)}`).replace(
                /\s*-\s*Google\s*Drive$/i,
                ''
              ) + '.md';
            const textBuf = Buffer.from(parsedHtml.bodyText, 'utf-8');
            const stored = await registerBufferAsServerUpload({
              fileName: cleanTitle,
              mimeType: 'text/markdown',
              buffer: textBuf,
              overrideExtractedText: parsedHtml.bodyText,
            });
            return {
              result: {
                url: originalUrl,
                normalizedFetchUrl: dlUrl,
                kind: 'google_drive_file',
                resourceId: fileId,
                status: 'ready',
                title: cleanTitle,
                mimeType: 'text/markdown',
                size: stored.size,
                serverFileId: stored.serverFileId,
                attachmentKind: 'text',
                extractedPreview: parsedHtml.bodyText.slice(0, 1200),
                scannedAt: nowIso,
              },
              attachments: [
                {
                  name: stored.fileName,
                  mimeType: stored.mimeType,
                  kind: 'text',
                  size: stored.size,
                  serverFileId: stored.serverFileId,
                  extractedText: parsedHtml.bodyText,
                },
              ],
            };
          }
          continue;
        }
      }

      const finalSniff = sniffBufferMimeAndExtension(
        buf,
        contentType,
        dispName || fallbackTitle || `Drive_${fileId.slice(0, 10)}`
      );

      if (finalSniff.isHtmlPage) continue;

      const stored = await registerBufferAsServerUpload({
        fileName: finalSniff.fileName,
        mimeType: finalSniff.mimeType,
        buffer: buf,
      });

      return {
        result: {
          url: originalUrl,
          normalizedFetchUrl: dlUrl,
          kind: 'google_drive_file',
          resourceId: fileId,
          status: 'ready',
          title: stored.fileName,
          mimeType: stored.mimeType,
          size: stored.size,
          serverFileId: stored.serverFileId,
          attachmentKind: stored.kind,
          extractedPreview: stored.extractedText?.slice(0, 1200),
          scannedAt: nowIso,
        },
        attachments: [
          {
            name: stored.fileName,
            mimeType: stored.mimeType,
            kind: stored.kind,
            size: stored.size,
            serverFileId: stored.serverFileId,
            extractedText: stored.extractedText,
          },
        ],
      };
    } catch {
      // Try next candidate URL
    }
  }

  return {
    result: {
      url: originalUrl,
      normalizedFetchUrl: candidateUrls[0],
      kind: 'google_drive_file',
      resourceId: fileId,
      status: 'warning',
      title: fallbackTitle || `Google Drive 文件 (${fileId.slice(0, 10)}...)`,
      errorMessage:
        '未能直接拉取该云盘文件字节流；请确认链接已开启「知道链接的任何人可查看」或通过上传按钮直接上传。',
      scannedAt: nowIso,
    },
    attachments: [],
  };
}

async function fetchGoogleDriveFolder(params: {
  folderId: string;
  originalUrl: string;
  driveToken?: string | null;
  maxFolderFiles: number;
}): Promise<{
  result: ScannedLinkResult;
  attachments: ServerAttachmentPayload[];
}> {
  const { folderId, originalUrl, driveToken, maxFolderFiles } = params;
  const nowIso = new Date().toISOString();
  const discoveredFiles: Array<{ id: string; name?: string }> = [];

  // Path A: Try Drive API list children
  if (driveToken) {
    try {
      const q = `'${folderId.replace(/'/g, '')}' in parents and trashed = false and mimeType != 'application/vnd.google-apps.folder'`;
      const listRes = await fetch(
        `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id,name,mimeType)&pageSize=${maxFolderFiles}&supportsAllDrives=true&includeItemsFromAllDrives=true`,
        {
          headers: { Authorization: `Bearer ${driveToken}` },
          signal: AbortSignal.timeout(12_000),
        }
      );
      if (listRes.ok) {
        const data = (await listRes.json()) as { files?: Array<{ id: string; name?: string }> };
        for (const f of data.files || []) {
          if (f.id) discoveredFiles.push({ id: f.id, name: f.name });
        }
      }
    } catch {
      // Fall back to public embedded folder view
    }
  }

  // Path B: Scrape public embeddedfolderview HTML (`entry-<FILE_ID>`)
  let folderTitle = `Google Drive 云盘文件夹 (${folderId.slice(0, 8)})`;
  if (discoveredFiles.length === 0) {
    try {
      const embedUrl = `https://drive.google.com/embeddedfolderview?id=${encodeURIComponent(folderId)}#list`;
      const res = await fetch(embedUrl, {
        headers: { 'User-Agent': BROWSER_USER_AGENT },
        signal: AbortSignal.timeout(15_000),
      });
      if (res.ok) {
        const html = await res.text();
        if (!isGoogleAuthWall(res.url || embedUrl, html)) {
          const parsedTitle = extractCleanTextFromHtml(html).title;
          if (parsedTitle) {
            folderTitle =
              parsedTitle.replace(/\s*-\s*Google\s*Drive$/i, '').trim() || folderTitle;
          }
        const entryMatches = html.matchAll(
          /id=["']entry-([a-zA-Z0-9_-]{10,})["'][\s\S]{0,600}?class=["']flip-entry-title["'][^>]*>([^<]+)</gi
        );
        for (const m of entryMatches) {
          if (discoveredFiles.length >= maxFolderFiles) break;
          discoveredFiles.push({
            id: m[1],
            name: decodeHtmlEntities(m[2].trim()),
          });
        }
        // Secondary pattern if class markup differs
          if (discoveredFiles.length === 0) {
            const linkMatches = html.matchAll(/\/file\/d\/([a-zA-Z0-9_-]{10,})/g);
            const seenIds = new Set<string>();
            for (const m of linkMatches) {
              if (seenIds.has(m[1])) continue;
              seenIds.add(m[1]);
              discoveredFiles.push({ id: m[1] });
              if (discoveredFiles.length >= maxFolderFiles) break;
            }
          }
        }
      }
    } catch {
      // Ignore
    }
  }

  if (discoveredFiles.length === 0) {
    return {
      result: {
        url: originalUrl,
        normalizedFetchUrl: `https://drive.google.com/embeddedfolderview?id=${folderId}#list`,
        kind: 'google_drive_folder',
        resourceId: folderId,
        status: 'warning',
        title: folderTitle,
        errorMessage:
          '未在该云盘文件夹中读取到公开文件列表；请确认文件夹已开启「知道链接的任何人可查看」或直接粘贴具体文件链接。',
        scannedAt: nowIso,
      },
      attachments: [],
    };
  }

  const collectedAttachments: ServerAttachmentPayload[] = [];
  const childSummaries: AttachmentSummary[] = [];

  for (const child of discoveredFiles.slice(0, maxFolderFiles)) {
    const sub = await fetchGoogleDriveSingleFile({
      fileId: child.id,
      originalUrl: `https://drive.google.com/file/d/${child.id}/view`,
      driveToken,
      fallbackTitle: child.name,
    });
    for (const att of sub.attachments) {
      collectedAttachments.push(att);
      childSummaries.push({
        id: `folder-item-${child.id}`,
        name: att.name,
        mimeType: att.mimeType,
        size: att.size || 0,
        kind: att.kind,
        serverFileId: att.serverFileId,
      });
    }
  }

  const totalBytes = collectedAttachments.reduce((s, a) => s + (a.size || 0), 0);
  return {
    result: {
      url: originalUrl,
      normalizedFetchUrl: `https://drive.google.com/embeddedfolderview?id=${folderId}#list`,
      kind: 'google_drive_folder',
      resourceId: folderId,
      status: collectedAttachments.length > 0 ? 'ready' : 'warning',
      title: `${folderTitle}（已抓取 ${collectedAttachments.length} 份文件）`,
      size: totalBytes,
      serverFileId: collectedAttachments[0]?.serverFileId,
      attachmentKind: collectedAttachments[0]?.kind,
      childCount: collectedAttachments.length,
      additionalAttachments: childSummaries,
      extractedPreview:
        collectedAttachments.length > 0
          ? `已从云盘文件夹自动抓取并挂载文件：${collectedAttachments.map((a) => a.name).join('、')}`
          : undefined,
      errorMessage:
        collectedAttachments.length === 0
          ? '已识别文件夹目录，但内部子文件未开启公开读取权限。'
          : undefined,
      scannedAt: nowIso,
    },
    attachments: collectedAttachments,
  };
}

async function fetchWorkspaceOrWebUrl(params: {
  descriptor: RecognizedLinkDescriptor;
  driveToken?: string | null;
}): Promise<{
  result: ScannedLinkResult;
  attachments: ServerAttachmentPayload[];
}> {
  const { descriptor, driveToken } = params;
  const nowIso = new Date().toISOString();

  if (descriptor.kind === 'google_drive_file' && descriptor.resourceId) {
    return fetchGoogleDriveSingleFile({
      fileId: descriptor.resourceId,
      originalUrl: descriptor.url,
      driveToken,
    });
  }

  if (descriptor.kind === 'google_drive_folder' && descriptor.resourceId) {
    return fetchGoogleDriveFolder({
      folderId: descriptor.resourceId,
      originalUrl: descriptor.url,
      driveToken,
      maxFolderFiles: 6,
    });
  }

  // Google Docs / Slides / Sheets: try Drive API export if token available, else public export URL
  if (
    (descriptor.kind === 'google_doc' ||
      descriptor.kind === 'google_slides' ||
      descriptor.kind === 'google_sheets') &&
    descriptor.resourceId
  ) {
    const viaDrive = await fetchGoogleDriveSingleFile({
      fileId: descriptor.resourceId,
      originalUrl: descriptor.url,
      driveToken,
      fallbackTitle: descriptor.displayLabel,
    });
    if (viaDrive.result.status === 'ready') {
      return {
        result: { ...viaDrive.result, kind: descriptor.kind },
        attachments: viaDrive.attachments,
      };
    }

    // Public Workspace export URL
    try {
      const res = await fetch(descriptor.normalizedFetchUrl, {
        headers: { 'User-Agent': BROWSER_USER_AGENT },
        redirect: 'follow',
        signal: AbortSignal.timeout(30_000),
      });
      if (res.ok) {
        const buf = Buffer.from(await res.arrayBuffer());
        const disp = parseContentDispositionFileName(res.headers.get('content-disposition'));
        const defaultName =
          descriptor.kind === 'google_sheets'
            ? `GoogleSheet_${descriptor.resourceId.slice(0, 8)}.csv`
            : `GoogleWorkspace_${descriptor.resourceId.slice(0, 8)}.pdf`;
        const sniff = sniffBufferMimeAndExtension(
          buf,
          res.headers.get('content-type') || '',
          disp || defaultName
        );
        if (!sniff.isHtmlPage) {
          const stored = await registerBufferAsServerUpload({
            fileName: sniff.fileName,
            mimeType: sniff.mimeType,
            buffer: buf,
          });
          return {
            result: {
              url: descriptor.url,
              normalizedFetchUrl: descriptor.normalizedFetchUrl,
              kind: descriptor.kind,
              resourceId: descriptor.resourceId,
              status: 'ready',
              title: stored.fileName,
              mimeType: stored.mimeType,
              size: stored.size,
              serverFileId: stored.serverFileId,
              attachmentKind: stored.kind,
              extractedPreview: stored.extractedText?.slice(0, 1200),
              scannedAt: nowIso,
            },
            attachments: [
              {
                name: stored.fileName,
                mimeType: stored.mimeType,
                kind: stored.kind,
                size: stored.size,
                serverFileId: stored.serverFileId,
                extractedText: stored.extractedText,
              },
            ],
          };
        }
      }
    } catch {
      // Fall through
    }
  }

  // arXiv / Direct Document / General Web URL
  try {
    const res = await fetch(descriptor.normalizedFetchUrl, {
      headers: {
        'User-Agent': BROWSER_USER_AGENT,
        Accept:
          'application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/html,text/plain,text/markdown,*/*;q=0.8',
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(35_000),
    });

    if (!res.ok) {
      return {
        result: {
          url: descriptor.url,
          normalizedFetchUrl: descriptor.normalizedFetchUrl,
          kind: descriptor.kind,
          resourceId: descriptor.resourceId,
          status: 'warning',
          title: descriptor.displayLabel,
          errorMessage: `目标链接响应状态码 ${res.status}，模型将尝试通过内置 URL 上下文直接读取。`,
          scannedAt: nowIso,
        },
        attachments: [],
      };
    }

    const buf = Buffer.from(await res.arrayBuffer());
    const dispName = parseContentDispositionFileName(res.headers.get('content-disposition'));
    const urlPathName = decodeURIComponent(
      new URL(descriptor.normalizedFetchUrl).pathname.split('/').pop() || ''
    );
    const fallbackFileName =
      dispName ||
      (descriptor.kind === 'arxiv_paper' && descriptor.resourceId
        ? `arXiv_${descriptor.resourceId.replace(/\//g, '_')}.pdf`
        : urlPathName || 'web_resource');

    const sniff = sniffBufferMimeAndExtension(
      buf,
      res.headers.get('content-type') || '',
      fallbackFileName
    );

    if (!sniff.isHtmlPage) {
      const stored = await registerBufferAsServerUpload({
        fileName: sniff.fileName,
        mimeType: sniff.mimeType,
        buffer: buf,
      });
      return {
        result: {
          url: descriptor.url,
          normalizedFetchUrl: descriptor.normalizedFetchUrl,
          kind: descriptor.kind,
          resourceId: descriptor.resourceId,
          status: 'ready',
          title: stored.fileName,
          mimeType: stored.mimeType,
          size: stored.size,
          serverFileId: stored.serverFileId,
          attachmentKind: stored.kind,
          extractedPreview: stored.extractedText?.slice(0, 1200),
          scannedAt: nowIso,
        },
        attachments: [
          {
            name: stored.fileName,
            mimeType: stored.mimeType,
            kind: stored.kind,
            size: stored.size,
            serverFileId: stored.serverFileId,
            extractedText: stored.extractedText,
          },
        ],
      };
    }

    // HTML Web Page: extract structured text, with Headless Chromium render fallback if SPA shell
    let htmlText = buf.toString('utf-8');
    if (isGoogleAuthWall(res.url || descriptor.normalizedFetchUrl, htmlText)) {
      return {
        result: {
          url: descriptor.url,
          normalizedFetchUrl: descriptor.normalizedFetchUrl,
          kind: descriptor.kind,
          resourceId: descriptor.resourceId,
          status: 'warning',
          title: descriptor.displayLabel,
          errorMessage:
            '目标 Google 链接需要公开读取权限，请将共享设为「知道链接的任何人可查看」或直接上传本地副本。',
          scannedAt: nowIso,
        },
        attachments: [],
      };
    }
    let extracted = extractCleanTextFromHtml(htmlText);

    if (extracted.bodyText.length < 240) {
      const renderedDom = await renderDomViaHeadlessChromium(descriptor.normalizedFetchUrl);
      if (renderedDom) {
        const rerendered = extractCleanTextFromHtml(renderedDom);
        if (rerendered.bodyText.length > extracted.bodyText.length) {
          htmlText = renderedDom;
          extracted = rerendered;
        }
      }
    }

    const pageTitle = extracted.title || descriptor.displayLabel;
    const formattedMarkdown = [
      `# 抓取网页来源：${pageTitle}`,
      `- 原始链接：${descriptor.url}`,
      extracted.description ? `- 页面摘要：${extracted.description}` : '',
      '',
      extracted.bodyText || '（页面正文为空，请结合链接上下文理解）',
    ]
      .filter(Boolean)
      .join('\n');

    const safeMdName = `${pageTitle.replace(/[\\/:*?"<>|]/g, '_').slice(0, 48) || '网页抓取内容'}.md`;
    const mdBuf = Buffer.from(formattedMarkdown, 'utf-8');
    const stored = await registerBufferAsServerUpload({
      fileName: safeMdName,
      mimeType: 'text/markdown',
      buffer: mdBuf,
      overrideExtractedText: formattedMarkdown,
    });

    return {
      result: {
        url: descriptor.url,
        normalizedFetchUrl: descriptor.normalizedFetchUrl,
        kind: descriptor.kind,
        resourceId: descriptor.resourceId,
        status: 'ready',
        title: pageTitle,
        mimeType: 'text/markdown',
        size: mdBuf.length,
        serverFileId: stored.serverFileId,
        attachmentKind: 'text',
        extractedPreview: extracted.bodyText.slice(0, 1500),
        scannedAt: nowIso,
      },
      attachments: [
        {
          name: stored.fileName,
          mimeType: 'text/markdown',
          kind: 'text',
          size: mdBuf.length,
          serverFileId: stored.serverFileId,
          extractedText: formattedMarkdown,
        },
      ],
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      result: {
        url: descriptor.url,
        normalizedFetchUrl: descriptor.normalizedFetchUrl,
        kind: descriptor.kind,
        resourceId: descriptor.resourceId,
        status: 'error',
        title: descriptor.displayLabel,
        errorMessage: `自动抓取链接超时或受限: ${msg}`,
        scannedAt: nowIso,
      },
      attachments: [],
    };
  }
}

/**
 * Recognizes, scrapes, exports, and ingests all links found in `rawText` or `urls`,
 * returning both UI-friendly `ScannedLinkResult[]` and ready-to-mount `ServerAttachmentPayload[]`.
 */
export async function scanAndIngestLinksFromInput(params: {
  rawText?: string;
  urls?: string[];
  driveToken?: string | null;
  forceRefresh?: boolean;
  existingServerFileIds?: Set<string>;
}): Promise<{
  scannedLinks: ScannedLinkResult[];
  ingestedAttachments: ServerAttachmentPayload[];
}> {
  const combinedSource = [params.rawText || '', ...(params.urls || [])].join('\n');
  const descriptors = extractRecognizedLinks(combinedSource).slice(0, 12);
  if (descriptors.length === 0) {
    return { scannedLinks: [], ingestedAttachments: [] };
  }

  const scannedLinks: ScannedLinkResult[] = [];
  const ingestedAttachments: ServerAttachmentPayload[] = [];
  const seenFileIds = new Set<string>(params.existingServerFileIds || []);

  for (const desc of descriptors) {
    const cacheKey = desc.resourceId ? `${desc.kind}:${desc.resourceId}` : desc.normalizedFetchUrl;
    const now = Date.now();
    const cached = !params.forceRefresh ? scanCache.get(cacheKey) : undefined;

    let outcome: { result: ScannedLinkResult; attachments: ServerAttachmentPayload[] };
    if (cached && cached.expiresAtMs > now && cached.result.status === 'ready') {
      outcome = { result: cached.result, attachments: cached.attachments };
    } else {
      outcome = await fetchWorkspaceOrWebUrl({
        descriptor: desc,
        driveToken: params.driveToken,
      });
      if (outcome.result.status === 'ready') {
        scanCache.set(cacheKey, {
          expiresAtMs: now + CACHE_TTL_MS,
          result: outcome.result,
          attachments: outcome.attachments,
        });
      }
    }

    scannedLinks.push(outcome.result);
    for (const att of outcome.attachments) {
      if (att.serverFileId && seenFileIds.has(att.serverFileId)) continue;
      if (att.serverFileId) seenFileIds.add(att.serverFileId);
      ingestedAttachments.push(att);
    }
  }

  return { scannedLinks, ingestedAttachments };
}
