export type DocMode = 'lecture_notes' | 'workbook';

export type DepthPreset = 'standard' | 'comprehensive' | 'exhaustive';

export type AttachmentKind = 'image' | 'pdf' | 'text' | 'docx' | 'audio' | 'binary';

export interface UploadedAttachment {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  kind: AttachmentKind;
  /** Base64 payload without data URL prefix (optional for small inline files) */
  base64Data?: string;
  /** Extracted UTF-8 text (for .txt, .md, .tex, .csv, .json, .docx) */
  extractedText?: string;
  /** Server-side chunked upload ID for unlimited-size files */
  serverFileId?: string;
  /** Gemini Files API URI for large PDFs, images, audio, video */
  fileUri?: string;
  /** Data URL for local image thumbnail preview */
  previewUrl?: string;
}

export interface AttachmentSummary {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  kind: AttachmentKind;
  serverFileId?: string;
  fileUri?: string;
}

export type RecognizedLinkKind =
  | 'google_drive_file'
  | 'google_drive_folder'
  | 'google_doc'
  | 'google_slides'
  | 'google_sheets'
  | 'arxiv_paper'
  | 'direct_document'
  | 'web_page';

export interface ScannedLinkResult {
  url: string;
  normalizedFetchUrl: string;
  kind: RecognizedLinkKind;
  resourceId?: string;
  status: 'ready' | 'warning' | 'error';
  title: string;
  mimeType?: string;
  size?: number;
  serverFileId?: string;
  attachmentKind?: AttachmentKind;
  extractedPreview?: string;
  childCount?: number;
  additionalAttachments?: AttachmentSummary[];
  errorMessage?: string;
  scannedAt: string;
}

export type PostCompletionExpansionMode = 'append_in_place' | 'derive_new_job';

export type VolumeSplitMode = 'auto' | 'multi_volume' | 'single_file';

export type VolumeRole =
  | 'main_lecture'
  | 'workbook'
  | 'solutions_manual'
  | 'chapter_volume'
  | 'supplement_volume';

export interface OutputVolumeSpec {
  volumeId: string;
  volumeIndex: number;
  volumeTitle: string;
  subtitle: string;
  suggestedFileName: string;
  role: VolumeRole;
  scopeSummary: string;
}

export interface GeneratedVolumeArtifact {
  volumeId: string;
  volumeIndex: number;
  volumeTitle: string;
  subtitle: string;
  fileName: string;
  role: VolumeRole;
  status:
    | 'pending'
    | 'generating'
    | 'compiling_pdf'
    | 'uploading_drive'
    | 'completed'
    | 'error';
  compiledMarkdown: string;
  charCount: number;
  formulaCount: number;
  estimatedPages: number;
  serverPdfReady: boolean;
  driveFileId?: string;
  driveWebViewLink?: string;
  draftFileId?: string;
  draftWebViewLink?: string;
  gcsObjectUri?: string;
  gcsWebLink?: string;
}

export type RequirementCategory =
  | 'scope'
  | 'volume_split'
  | 'style_notation'
  | 'problem_design'
  | 'correction';

export interface ConsolidatedRequirementItem {
  id: string;
  category: RequirementCategory;
  summary: string;
  sourceLabel: string;
  status: 'active' | 'superseded';
  supersededBy?: string;
  targetVolumeIds?: string[];
}

export interface ConsolidatedRequirementState {
  version: number;
  lastConsolidatedAt: string;
  synthesizedMasterBrief: string;
  activeRules: ConsolidatedRequirementItem[];
  changeLog: string[];
  rawAccumulatedChars: number;
  compressedContextChars: number;
  tokenSavingsEstimatePct: number;
}

export interface SupplementalDirective {
  id: string;
  createdAt: string;
  text: string;
  source: 'text' | 'voice';
  attachmentsMeta: AttachmentSummary[];
  scannedLinks?: ScannedLinkResult[];
  /** Indicates whether this directive has already been injected into a completed/running batch */
  status: 'queued' | 'applied';
  appliedBatchIndex?: number;
}

export interface TaskBatchSpec {
  batchIndex: number;
  title: string;
  scopeSummary: string;
  sections: string[];
  estimatedPages: number;
  targetWords: number;
  includeAnswerKey: boolean;
  volumeId?: string;
  volumeIndex?: number;
  isSupplementalBatch?: boolean;
  isExpansionBatch?: boolean;
  isAutoOverflowRound?: boolean;
}

export interface ExpandedPlan {
  documentTitle: string;
  subtitle: string;
  subjectCategory: string;
  courseCode: string;
  archiveRootFolder: string;
  archiveSubjectFolder: string;
  suggestedFileName: string;
  expandedPrompt: string;
  pedagogicalGoals: string[];
  isMultiVolume?: boolean;
  volumes?: OutputVolumeSpec[];
  singleCallTargetWords?: number;
  adaptiveStrategyNote?: string;
  batches: TaskBatchSpec[];
}

export type BatchStatus = 'pending' | 'running' | 'continuing' | 'completed' | 'error';

export type ResumeStrategy = 'continue' | 'retry_batch';

export interface BatchExecutionState {
  batchIndex: number;
  title: string;
  volumeId?: string;
  volumeIndex?: number;
  status: BatchStatus;
  continuationCount: number;
  autoRetryCount?: number;
  markdownContent: string;
  thoughtSummary?: string;
  startedAt?: string;
  completedAt?: string;
  errorMessage?: string;
}

export type PipelineStage =
  | 'planning'
  | 'executing'
  | 'compiling_pdf'
  | 'uploading_drive'
  | 'completed'
  | 'error'
  | 'cancelled';

export type DriveSyncStatus = 'idle' | 'uploading' | 'archived' | 'pending_auth' | 'error';

export interface DriveArchiveInfo {
  status: DriveSyncStatus;
  folderId?: string;
  folderPath?: string;
  fileId?: string;
  webViewLink?: string;
  draftFileId?: string;
  draftWebViewLink?: string;
  checkpointFileId?: string;
  /** Optional user-owned Google Cloud Storage URI (gs://bucket/object) */
  gcsObjectUri?: string;
  gcsWebLink?: string;
  lastSyncedAt?: string;
  archivedAt?: string;
  error?: string;
}

export interface JobBillingSnapshot {
  billingMode: 'super_admin_free' | 'monthly_pro_quota' | 'pay_per_pdf';
  estimatedPages: number;
  estimatedTokens: number;
  actualInputTokens?: number;
  actualOutputTokens?: number;
  actualTotalTokens?: number;
  upstreamApiCostCny: number;
  chargedCny: number;
  grossMarginRate: number;
}

export interface PipelineJob {
  id: string;
  createdAt: string;
  updatedAt: string;
  /** Normalized Google account email for cross-device sync & tenant isolation */
  ownerEmail?: string;
  ownerUid?: string;
  clientDeviceId?: string;
  /** Parent job ID when derived or expanded from an earlier completed task */
  parentJobId?: string;
  /** Explicit historical job IDs bound for deep long-context reference */
  sourceContextJobIds?: string[];
  /** Whether cross-task strong historical memory is enabled (default true) */
  enableHistoricalMemory?: boolean;
  /** Number of post-completion seamless expansions applied to this job */
  expansionCount?: number;
  /** Automatically recognized & scanned URLs / Google Drive links from user input */
  scannedLinks?: ScannedLinkResult[];
  mode: DocMode;
  depth: DepthPreset;
  volumeSplitMode?: VolumeSplitMode;
  rawUserPrompt: string;
  customRootFolder: string;
  autoArchiveDrive: boolean;
  attachmentsMeta: AttachmentSummary[];
  supplementalDirectives?: SupplementalDirective[];
  consolidatedRequirements?: ConsolidatedRequirementState;
  outputVolumes?: GeneratedVolumeArtifact[];
  stage: PipelineStage;
  failedStage?: PipelineStage;
  executionHost?: 'server_cloud' | 'local';
  serverPdfReady?: boolean;
  /** True when PDF resides solely in user's own Google Cloud and downloads locally only on click */
  cloudOnlyHosted?: boolean;
  autoRecoveryCount?: number;
  plan: ExpandedPlan | null;
  batches: BatchExecutionState[];
  compiledMarkdown: string;
  charCount: number;
  formulaCount: number;
  estimatedPages: number;
  driveArchive: DriveArchiveInfo;
  billing?: JobBillingSnapshot;
  errorMessage?: string;
}

export type UserRole = 'super_admin' | 'pro_monthly' | 'pay_per_use';

export interface UserCloudConfig {
  mode: 'google_drive' | 'google_cloud_storage_and_drive';
  driveRootFolder: string;
  gcpProjectId: string;
  gcsBucketName: string;
  /** Keep generated files in user's Google Cloud; download to local disk ONLY when clicking Download */
  downloadOnDemandOnly: boolean;
}

export interface UsageWindowSnapshot {
  sixHourTokensUsed: number;
  sixHourTokensLimit: number;
  sixHourTasksUsed: number;
  sixHourTasksLimit: number;
  sixHourResetAt: string;
  weeklyTokensUsed: number;
  weeklyTokensLimit: number;
  weeklyTasksUsed: number;
  weeklyTasksLimit: number;
  weeklyResetAt: string;
}

export interface PricingConfig {
  inputTokenPricePerMillionCny: number;
  outputTokenPricePerMillionCny: number;
  payPerPdfGrossMargin: number;
  monthlyPriceCny: number;
  monthlyGrossMargin: number;
  sixHourTokenLimit: number;
  sixHourTaskLimit: number;
  weeklyTokenLimit: number;
  weeklyTaskLimit: number;
}

export interface CostEstimateBreakdown {
  estimatedPages: number;
  estimatedInputTokens: number;
  estimatedOutputAndThinkingTokens: number;
  estimatedTotalTokens: number;
  attachmentTokens: number;
  upstreamApiCostCny: number;
  payPerPdfPriceCny: number;
  perPagePriceCny: number;
  basePlanningFeeCny: number;
  grossProfitCny: number;
  grossMarginRate: number;
}

export interface BillingTransaction {
  id: string;
  createdAt: string;
  type: 'topup' | 'pay_per_pdf_charge' | 'monthly_subscription' | 'admin_grant';
  amountCny: number;
  description: string;
  jobId?: string;
}

export interface UserAccountProfile {
  email: string;
  uid: string;
  displayName: string;
  photoURL?: string;
  role: UserRole;
  isSuperAdmin: boolean;
  walletBalanceCny: number;
  subscriptionActive: boolean;
  subscriptionExpiresAt?: string;
  cloudConfig: UserCloudConfig;
  usage: UsageWindowSnapshot;
  totalSpentCny: number;
  totalApiCostCny: number;
  totalGeneratedPages: number;
  totalTokensConsumed: number;
  recentTransactions: BillingTransaction[];
}

export interface AdminSystemOverview {
  superAdminEmail: string;
  pricing: PricingConfig;
  totalUsers: number;
  activeSubscribers: number;
  totalRevenueCny: number;
  totalApiCostCny: number;
  realizedGrossMargin: number;
  activeRunningJobsCount: number;
  totalJobsCount: number;
  users: Array<{
    email: string;
    displayName: string;
    role: UserRole;
    walletBalanceCny: number;
    subscriptionActive: boolean;
    subscriptionExpiresAt?: string;
    sixHourTokensUsed: number;
    weeklyTokensUsed: number;
    totalSpentCny: number;
    totalApiCostCny: number;
  }>;
}

export type ActiveNavTab = 'composer' | 'monitor' | 'history' | 'billing_admin';
