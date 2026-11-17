import { initializeApp } from 'firebase/app';
import type { FirebaseApp } from 'firebase/app';
import {
  getAuth,
  GoogleAuthProvider,
  onAuthStateChanged,
  signInWithPopup,
} from 'firebase/auth';
import type { Auth, Unsubscribe, User } from 'firebase/auth';
import firebaseConfig from '../../firebase-applet-config.json';

export const SCOPES = [
  'https://www.googleapis.com/auth/drive.file',
];

const HAS_SIGNED_IN_FLAG = 'carbon_has_signed_in';

let firebaseApp: FirebaseApp | null = null;
let firebaseAuth: Auth | null = null;
let authListenerUnsubscribe: Unsubscribe | null = null;

// Strictly in-memory OAuth access token cache (never stored in localStorage or sessionStorage)
let isSigningIn = false;
let cachedAccessToken: string | null = null;
let currentFirebaseUser: User | null = null;

let registeredSuccessCb: ((user: User, token: string) => void) | undefined;
let registeredFailureCb: ((user: User | null) => void) | undefined;

function getGoogleProvider(): GoogleAuthProvider {
  const provider = new GoogleAuthProvider();
  for (const scope of SCOPES) {
    provider.addScope(scope);
  }
  provider.setCustomParameters({
    prompt: 'consent',
  });
  return provider;
}

function ensureFirebaseAuth(): Auth {
  if (!firebaseApp) {
    firebaseApp = initializeApp(firebaseConfig);
  }
  if (!firebaseAuth) {
    firebaseAuth = getAuth(firebaseApp);
    authListenerUnsubscribe = onAuthStateChanged(firebaseAuth, (user: User | null) => {
      currentFirebaseUser = user;
      if (user) {
        if (cachedAccessToken) {
          registeredSuccessCb?.(user, cachedAccessToken);
        } else if (!isSigningIn) {
          registeredFailureCb?.(user);
        }
      } else {
        cachedAccessToken = null;
        registeredFailureCb?.(null);
      }
    });
  }
  return firebaseAuth;
}

export const initAuth = (
  onAuthSuccess?: (user: User, token: string) => void,
  onAuthFailure?: (user: User | null) => void
) => {
  registeredSuccessCb = onAuthSuccess;
  registeredFailureCb = onAuthFailure;

  // Restore Firebase account identity automatically ONLY if user previously signed in on this browser
  let hadPriorSignIn = false;
  try {
    hadPriorSignIn = localStorage.getItem(HAS_SIGNED_IN_FLAG) === '1';
  } catch {
    // Ignore storage access errors
  }

  if (hadPriorSignIn) {
    ensureFirebaseAuth();
  } else if (!cachedAccessToken) {
    onAuthFailure?.(null);
  }

  return () => {
    registeredSuccessCb = undefined;
    registeredFailureCb = undefined;
    if (authListenerUnsubscribe) {
      authListenerUnsubscribe();
      authListenerUnsubscribe = null;
    }
  };
};

export const googleSignIn = async (): Promise<{ user: User; accessToken: string }> => {
  try {
    isSigningIn = true;
    const auth = ensureFirebaseAuth();
    const provider = getGoogleProvider();
    const result = await signInWithPopup(auth, provider);
    const credential = GoogleAuthProvider.credentialFromResult(result);
    if (!credential?.accessToken) {
      throw new Error('未能从 Google 授权结果中获取云盘访问令牌，请重试。');
    }
    currentFirebaseUser = result.user;
    cachedAccessToken = credential.accessToken;
    try {
      localStorage.setItem(HAS_SIGNED_IN_FLAG, '1');
    } catch {
      // Ignore
    }
    registeredSuccessCb?.(result.user, cachedAccessToken);
    return { user: result.user, accessToken: cachedAccessToken };
  } finally {
    isSigningIn = false;
  }
};

export const getAccessToken = (): string | null => {
  return cachedAccessToken;
};

export const getFirebaseIdToken = async (): Promise<string | null> => {
  const user = currentFirebaseUser || firebaseAuth?.currentUser;
  if (!user) return null;
  try {
    return await user.getIdToken();
  } catch {
    return null;
  }
};

export const logout = async (): Promise<void> => {
  try {
    localStorage.removeItem(HAS_SIGNED_IN_FLAG);
  } catch {
    // Ignore
  }
  currentFirebaseUser = null;
  if (firebaseAuth) {
    await firebaseAuth.signOut();
  }
  cachedAccessToken = null;
};

function escapeDriveQueryLiteral(str: string): string {
  return str.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

export async function findOrCreateDriveFolder(
  accessToken: string,
  folderName: string,
  parentId?: string
): Promise<string> {
  const parentClause = parentId ? ` and '${parentId}' in parents` : '';
  const query = `name = '${escapeDriveQueryLiteral(folderName)}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false${parentClause}`;
  const searchUrl = `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(query)}&fields=files(id,name)&pageSize=5`;

  const searchRes = await fetch(searchUrl, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (searchRes.status === 401 || searchRes.status === 403) {
    cachedAccessToken = null;
    throw new Error('AUTH_EXPIRED');
  }

  if (!searchRes.ok) {
    const errText = await searchRes.text();
    throw new Error(`查询个人 Google Drive 归档目录失败: ${errText}`);
  }

  const searchData = (await searchRes.json()) as { files?: Array<{ id: string; name: string }> };
  if (searchData.files && searchData.files.length > 0) {
    return searchData.files[0].id;
  }

  const createRes = await fetch('https://www.googleapis.com/drive/v3/files?fields=id,name', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      name: folderName,
      mimeType: 'application/vnd.google-apps.folder',
      ...(parentId ? { parents: [parentId] } : {}),
    }),
  });

  if (!createRes.ok) {
    const errText = await createRes.text();
    throw new Error(`创建 Google Drive 文件夹「${folderName}」失败: ${errText}`);
  }

  const created = (await createRes.json()) as { id: string };
  return created.id;
}

export async function archivePdfToGoogleDrive(params: {
  accessToken: string;
  pdfBlob: Blob;
  fileName: string;
  rootFolder: string;
  subjectFolder: string;
  categoryFolder: string;
  description?: string;
}): Promise<{
  fileId: string;
  webViewLink: string;
  folderPath: string;
}> {
  const {
    accessToken,
    pdfBlob,
    fileName,
    rootFolder,
    subjectFolder,
    categoryFolder,
    description,
  } = params;

  const rootId = await findOrCreateDriveFolder(accessToken, rootFolder);
  const subjectId = await findOrCreateDriveFolder(accessToken, subjectFolder, rootId);
  const leafFolderId = await findOrCreateDriveFolder(accessToken, categoryFolder, subjectId);

  const metadata = {
    name: fileName,
    mimeType: 'application/pdf',
    parents: [leafFolderId],
    description: description || 'Generated & archived by Carbon Scholar Studio',
  };

  const form = new FormData();
  form.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }));
  form.append('file', pdfBlob, fileName);

  const uploadRes = await fetch(
    'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,webViewLink',
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
      body: form,
    }
  );

  if (uploadRes.status === 401 || uploadRes.status === 403) {
    cachedAccessToken = null;
    throw new Error('AUTH_EXPIRED');
  }

  if (!uploadRes.ok) {
    const errText = await uploadRes.text();
    throw new Error(`上传 PDF 到个人 Google Drive 失败: ${errText}`);
  }

  const uploaded = (await uploadRes.json()) as {
    id: string;
    name: string;
    webViewLink?: string;
  };

  return {
    fileId: uploaded.id,
    webViewLink: uploaded.webViewLink || `https://drive.google.com/file/d/${uploaded.id}/view`,
    folderPath: `${rootFolder} / ${subjectFolder} / ${categoryFolder}`,
  };
}

export async function deleteDriveArchivedFile(
  accessToken: string,
  fileId: string
): Promise<void> {
  const res = await fetch(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}`, {
    method: 'DELETE',
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });

  if (!res.ok && res.status !== 404) {
    const errText = await res.text();
    throw new Error(`删除云端归档文件失败: ${errText}`);
  }
}
