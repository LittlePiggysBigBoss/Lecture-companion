import React, { useState } from 'react';
import { AlertTriangle } from 'lucide-react';

interface ConfirmDialogProps {
  open: boolean;
  title: string;
  description: string;
  canAlsoDeleteDriveFile?: boolean;
  driveFolderPath?: string;
  confirmLabel?: string;
  onCancel: () => void;
  onConfirm: (alsoDeleteFromDrive: boolean) => void;
}

export const ConfirmDialog: React.FC<ConfirmDialogProps> = ({
  open,
  title,
  description,
  canAlsoDeleteDriveFile = false,
  driveFolderPath,
  confirmLabel = '确认删除',
  onCancel,
  onConfirm,
}) => {
  const [deleteDriveCopy, setDeleteDriveCopy] = useState(false);

  if (!open) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="confirm-dialog-title"
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/40"
    >
      <div className="w-full max-w-md bg-white border border-slate-200 rounded-xl p-6">
        <div className="flex items-start gap-3">
          <div className="p-2 bg-red-50 text-red-600 rounded-lg shrink-0">
            <AlertTriangle className="w-5 h-5" aria-hidden="true" />
          </div>
          <div className="min-w-0 flex-1">
            <h2 id="confirm-dialog-title" className="text-base font-semibold text-slate-900">
              {title}
            </h2>
            <p className="mt-1.5 text-sm text-slate-600 leading-relaxed">{description}</p>

            {canAlsoDeleteDriveFile && (
              <label className="mt-4 flex items-start gap-2.5 p-3 bg-slate-50 border border-slate-200 rounded-lg cursor-pointer">
                <input
                  type="checkbox"
                  checked={deleteDriveCopy}
                  onChange={(e) => setDeleteDriveCopy(e.target.checked)}
                  className="mt-0.5 rounded border-slate-300 text-red-600 focus:ring-red-500"
                />
                <span className="text-xs text-slate-700 leading-relaxed">
                  同时从我的 Google Drive 云端移除该归档 PDF 文件
                  {driveFolderPath ? `（位于 ${driveFolderPath}）` : ''}
                </span>
              </label>
            )}
          </div>
        </div>

        <div className="mt-6 flex items-center justify-end gap-3">
          <button
            type="button"
            onClick={() => {
              setDeleteDriveCopy(false);
              onCancel();
            }}
            className="px-4 py-2 text-xs font-medium text-slate-700 bg-white border border-slate-200 rounded-lg hover:bg-slate-50 transition-colors whitespace-nowrap shrink-0"
          >
            取消
          </button>
          <button
            type="button"
            onClick={() => {
              const choice = deleteDriveCopy;
              setDeleteDriveCopy(false);
              onConfirm(choice);
            }}
            className="px-4 py-2 text-xs font-medium text-white bg-red-600 rounded-lg hover:bg-red-700 transition-colors whitespace-nowrap shrink-0"
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
};
