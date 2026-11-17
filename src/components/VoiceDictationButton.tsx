import React, { useEffect, useRef, useState } from 'react';
import { Loader2, Mic, Square } from 'lucide-react';
import { transcribeVoiceBlob } from '../services/fileAndVoiceClient';

interface VoiceDictationButtonProps {
  disabled?: boolean;
  label?: string;
  onTranscribed: (text: string) => void;
  onError?: (errMsg: string) => void;
}

export const VoiceDictationButton: React.FC<VoiceDictationButtonProps> = ({
  disabled = false,
  label = '语音录入',
  onTranscribed,
  onError,
}) => {
  const [isRecording, setIsRecording] = useState(false);
  const [isTranscribing, setIsTranscribing] = useState(false);
  const [seconds, setSeconds] = useState(0);

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<BlobPart[]>([]);
  const timerRef = useRef<number | null>(null);

  const cleanupRecording = () => {
    if (timerRef.current) {
      window.clearInterval(timerRef.current);
      timerRef.current = null;
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
    mediaRecorderRef.current = null;
  };

  useEffect(() => {
    return () => {
      cleanupRecording();
    };
  }, []);

  const startRecording = async () => {
    if (!navigator.mediaDevices?.getUserMedia) {
      onError?.('当前浏览器环境不支持麦克风录音，请直接输入文字或上传语音音频文件。');
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      chunksRef.current = [];

      const preferredMime = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
        ? 'audio/webm;codecs=opus'
        : MediaRecorder.isTypeSupported('audio/webm')
          ? 'audio/webm'
          : '';

      const recorder = preferredMime
        ? new MediaRecorder(stream, { mimeType: preferredMime })
        : new MediaRecorder(stream);

      mediaRecorderRef.current = recorder;

      recorder.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) {
          chunksRef.current.push(e.data);
        }
      };

      recorder.onstop = async () => {
        const mimeType = recorder.mimeType || 'audio/webm';
        const audioBlob = new Blob(chunksRef.current, { type: mimeType });
        cleanupRecording();
        setIsRecording(false);

        if (audioBlob.size < 200) {
          return;
        }

        setIsTranscribing(true);
        try {
          const transcript = await transcribeVoiceBlob(audioBlob, mimeType);
          if (transcript) {
            onTranscribed(transcript);
          } else {
            onError?.('未识别到清晰语音内容，请靠近麦克风重试。');
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          onError?.(msg);
        } finally {
          setIsTranscribing(false);
        }
      };

      recorder.start(250);
      setSeconds(0);
      setIsRecording(true);
      timerRef.current = window.setInterval(() => {
        setSeconds((prev) => prev + 1);
      }, 1000);
    } catch (err) {
      cleanupRecording();
      setIsRecording(false);
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('Permission') || msg.includes('NotAllowed')) {
        onError?.('麦克风权限被拒绝，请在浏览器地址栏允许麦克风访问后重试。');
      } else {
        onError?.(`启动语音录入失败：${msg}`);
      }
    }
  };

  const stopRecording = () => {
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
      mediaRecorderRef.current.stop();
    } else {
      cleanupRecording();
      setIsRecording(false);
    }
  };

  const formatTimer = (s: number) => {
    const mm = String(Math.floor(s / 60)).padStart(2, '0');
    const ss = String(s % 60).padStart(2, '0');
    return `${mm}:${ss}`;
  };

  if (isTranscribing) {
    return (
      <button
        type="button"
        disabled
        className="inline-flex items-center gap-2 px-3.5 py-2 text-xs font-medium text-blue-700 bg-blue-50 border border-blue-200 rounded-lg whitespace-nowrap shrink-0"
      >
        <Loader2 className="w-3.5 h-3.5 animate-spin text-blue-600" aria-hidden="true" />
        <span>正在识别语音...</span>
      </button>
    );
  }

  if (isRecording) {
    return (
      <button
        type="button"
        onClick={stopRecording}
        aria-label="停止语音录入并转写"
        className="inline-flex items-center gap-2 px-3.5 py-2 text-xs font-semibold text-red-700 bg-red-50 border border-red-300 rounded-lg hover:bg-red-100 transition-colors whitespace-nowrap shrink-0"
      >
        <Square className="w-3.5 h-3.5 fill-current text-red-600" aria-hidden="true" />
        <span className="font-mono tabular-nums">停止录音 ({formatTimer(seconds)})</span>
      </button>
    );
  }

  return (
    <button
      type="button"
      disabled={disabled}
      onClick={() => void startRecording()}
      className="inline-flex items-center gap-2 px-3.5 py-2 text-xs font-medium text-slate-700 bg-white border border-slate-200 rounded-lg hover:bg-slate-100 disabled:opacity-50 transition-colors whitespace-nowrap shrink-0"
    >
      <Mic className="w-3.5 h-3.5 text-blue-600" aria-hidden="true" />
      <span>{label}</span>
    </button>
  );
};
