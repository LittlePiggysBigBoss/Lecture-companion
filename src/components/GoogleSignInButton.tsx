import React from 'react';
import type { User } from 'firebase/auth';
import { FolderCheck, LogOut } from 'lucide-react';

interface GoogleSignInButtonProps {
  user: User | null;
  hasDriveToken: boolean;
  isSigningIn: boolean;
  onSignIn: () => void;
  onSignOut: () => void;
}

export const GoogleSignInButton: React.FC<GoogleSignInButtonProps> = ({
  user,
  hasDriveToken,
  isSigningIn,
  onSignIn,
  onSignOut,
}) => {
  if (user && hasDriveToken) {
    return (
      <div className="flex items-center gap-3 shrink-0">
        <div className="hidden sm:flex items-center gap-2 text-xs text-slate-600">
          <FolderCheck className="w-4 h-4 text-emerald-600 shrink-0" aria-hidden="true" />
          <span className="font-medium text-slate-800 truncate max-w-[180px]">
            {user.displayName || user.email || 'Google Drive 已连接'}
          </span>
          <span aria-hidden="true">·</span>
          <span className="text-emerald-700 whitespace-nowrap">Drive 自动归档已就绪</span>
        </div>
        <button
          type="button"
          onClick={onSignOut}
          aria-label="退出 Google 账号连接"
          className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-600 bg-white border border-slate-200 rounded-lg hover:bg-slate-50 hover:text-slate-900 transition-colors whitespace-nowrap shrink-0"
        >
          <LogOut className="w-3.5 h-3.5" aria-hidden="true" />
          <span>退出连接</span>
        </button>
      </div>
    );
  }

  return (
    <button
      type="button"
      onClick={onSignIn}
      disabled={isSigningIn}
      className="gsi-material-button shrink-0"
      aria-label="Sign in with Google 以启用 Google Drive 自动归档"
    >
      <div className="gsi-material-button-content-wrapper">
        <div className="gsi-material-button-icon" aria-hidden="true">
          <svg
            version="1.1"
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 48 48"
            style={{ display: 'block' }}
          >
            <path
              fill="#EA4335"
              d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"
            />
            <path
              fill="#4285F4"
              d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"
            />
            <path
              fill="#FBBC05"
              d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"
            />
            <path
              fill="#34A853"
              d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"
            />
            <path fill="none" d="M0 0h48v48H0z" />
          </svg>
        </div>
        <span className="gsi-material-button-contents">
          {isSigningIn ? '正在连接 Google...' : 'Sign in with Google'}
        </span>
      </div>
    </button>
  );
};
