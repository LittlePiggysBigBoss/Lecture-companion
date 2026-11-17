import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildTokenEfficientExecutionContext,
  computeVolumeArtifactsFromBatches,
  consolidateRequirementsPure,
  detectMultiVolumeIntent,
  normalizeAdaptivePlanAndVolumes,
} from './adaptiveWorkflowLogic';
import type { SupplementalDirective } from '../types';

test('detectMultiVolumeIntent detects separate solutions manual and chapter-by-chapter splits accurately', () => {
  const sepAns = detectMultiVolumeIntent({
    rawPrompt:
      '制作 physics bowl 英文讲义 lecture notes，图文详细，例题准确，要求答案和解析另外一份文件输出',
  });
  assert.equal(sepAns.shouldSplitVolumes, true);
  assert.equal(sepAns.hasSeparateSolutions, true);
  assert.equal(sepAns.splitPattern, 'content_and_solutions');

  const byChapter = detectMultiVolumeIntent({
    rawPrompt:
      '继续撰写完善并升级这份 physics bowl 讲义，按章节拆分成数学基础，运动学，力学，电磁学独立文件输出',
  });
  assert.equal(byChapter.shouldSplitVolumes, true);
  assert.equal(byChapter.splitPattern, 'by_chapter_modules');
  assert.ok(byChapter.detectedModules.length >= 3);

  const compoundModules = detectMultiVolumeIntent({
    rawPrompt:
      '制作一份高阶物理竞赛全套讲义，按章节拆分成数学基础与运动学、牛顿动力学与守恒律两份独立分册文件输出，并且所有例题和配套训练题的答案和详细解析另外一份独立文件输出，不要限制生成轮次，确保推导详尽。',
  });
  assert.equal(compoundModules.shouldSplitVolumes, true);
  assert.deepEqual(compoundModules.detectedModules, ['数学基础与运动学', '牛顿动力学与守恒律']);
  assert.equal(compoundModules.hasSeparateSolutions, true);
  assert.ok(compoundModules.reasonSummary.includes('共 3 份独立 PDF'));

  const splitIntoThree = detectMultiVolumeIntent({
    rawPrompt: '继续撰写升级改进这份讲义，按照板块units把讲义拆分为三份',
  });
  assert.equal(splitIntoThree.shouldSplitVolumes, true);

  const singleDoc = detectMultiVolumeIntent({
    rawPrompt: '帮我写一份关于矩阵奇异值分解 SVD 与 PCA 低秩近似的深度课程讲义',
  });
  assert.equal(singleDoc.shouldSplitVolumes, false);
  assert.equal(singleDoc.splitPattern, 'none');
});

test('detectMultiVolumeIntent follows mid-run supplemental directive changes (turn split ON or OFF)', () => {
  const directivesTurnOn: SupplementalDirective[] = [
    {
      id: 'd1',
      createdAt: '2026-11-16T10:00:00Z',
      text: '补充要求：把所有例题的答案和详细解析单独一份文件输出，方便学生先做题',
      source: 'text',
      attachmentsMeta: [],
      status: 'queued',
    },
  ];
  const turnedOn = detectMultiVolumeIntent({
    rawPrompt: '生成一份高等微积分极限与连续性讲义',
    directives: directivesTurnOn,
  });
  assert.equal(turnedOn.shouldSplitVolumes, true);
  assert.equal(turnedOn.hasSeparateSolutions, true);

  const directivesTurnOff: SupplementalDirective[] = [
    ...directivesTurnOn,
    {
      id: 'd2',
      createdAt: '2026-11-16T10:05:00Z',
      text: '最新调整：不要分册了，全部合并为一份完整 PDF 输出即可',
      source: 'voice',
      attachmentsMeta: [],
      status: 'queued',
    },
  ];
  const turnedOff = detectMultiVolumeIntent({
    rawPrompt: '生成一份高等微积分极限与连续性讲义',
    directives: directivesTurnOff,
  });
  assert.equal(turnedOff.shouldSplitVolumes, false);
});

test('consolidateRequirementsPure deduplicates rules and supersedes conflicting earlier requirements', () => {
  const directives: SupplementalDirective[] = [
    {
      id: 'd1',
      createdAt: '2026-11-16T10:00:00Z',
      text: '请改为全英文讲义输出；并且所有答案和解析另外一份文件输出',
      source: 'text',
      attachmentsMeta: [],
      status: 'queued',
    },
    {
      id: 'd2',
      createdAt: '2026-11-16T10:02:00Z',
      text: '请改为全英文讲义输出；增加两道刚体转动角动量守恒压轴真题',
      source: 'voice',
      attachmentsMeta: [],
      status: 'queued',
    },
  ];

  const consolidated = consolidateRequirementsPure({
    rawUserPrompt: '制作一份全中文大学物理力学讲义，涵盖牛顿定律与动量守恒',
    directives,
  });

  const superseded = consolidated.activeRules.filter((r) => r.status === 'superseded');
  const active = consolidated.activeRules.filter((r) => r.status === 'active');

  assert.equal(superseded.length, 1);
  assert.ok(superseded[0].summary.includes('全中文'));
  assert.ok(active.some((r) => r.summary.includes('全英文')));
  assert.ok(active.some((r) => r.category === 'volume_split'));
  assert.ok(consolidated.changeLog.length >= 2);
});

test('normalizeAdaptivePlanAndVolumes preserves unbounded round counts (e.g. 7 rounds across 3 volumes) without 4-batch cap', () => {
  const detection = detectMultiVolumeIntent({
    rawPrompt: '按章节拆分成数学基础、运动学、力学三份独立分册，每册详尽展开',
  });

  const rawParsed = {
    documentTitle: 'Physics Bowl 竞赛讲义全集',
    subtitle: '分章节多卷独立出版级讲义',
    subjectCategory: '竞赛物理',
    courseCode: 'PHYS-301',
    suggestedFileName: 'PhysicsBowl_Master.pdf',
    expandedPrompt: '按数学基础、运动学、力学拆分为三份独立 PDF 文件，共 7 轮极限生成。',
    pedagogicalGoals: ['掌握微积分物理工具', '精通运动学与动力学建模'],
    volumes: [
      {
        volumeId: 'vol-1',
        volumeIndex: 1,
        volumeTitle: '第 1 分册：数学基础与矢量微积分',
        subtitle: '竞赛数学工具箱',
        suggestedFileName: 'PHYS301_Vol1_Math.pdf',
        role: 'chapter_volume',
        scopeSummary: '矢量代数、微积分近似与微分方程',
      },
      {
        volumeId: 'vol-2',
        volumeIndex: 2,
        volumeTitle: '第 2 分册：一维与二维运动学',
        subtitle: '运动学与相对运动',
        suggestedFileName: 'PHYS301_Vol2_Kinematics.pdf',
        role: 'chapter_volume',
        scopeSummary: '抛体、圆周运动与极坐标运动学',
      },
      {
        volumeId: 'vol-3',
        volumeIndex: 3,
        volumeTitle: '第 3 分册：牛顿动力学与守恒律',
        subtitle: '力学核心体系',
        suggestedFileName: 'PHYS301_Vol3_Mechanics.pdf',
        role: 'chapter_volume',
        scopeSummary: '受力分析、非惯性系、功与能、碰撞与角动量',
      },
    ],
    batches: Array.from({ length: 7 }, (_, i) => ({
      batchIndex: i + 1,
      title: `第 ${i + 1} 轮高密度章节编纂`,
      scopeSummary: `第 ${i + 1} 轮满载内容`,
      sections: [`专题 ${i + 1}.1`, `专题 ${i + 1}.2`],
      estimatedPages: 12,
      targetWords: 11500,
      includeAnswerKey: true,
      volumeId: i < 2 ? 'vol-1' : i < 4 ? 'vol-2' : 'vol-3',
      volumeIndex: i < 2 ? 1 : i < 4 ? 2 : 3,
    })),
  };

  const plan = normalizeAdaptivePlanAndVolumes({
    rawParsed,
    mode: 'lecture_notes',
    depth: 'comprehensive',
    customRootFolder: 'Carbon 学术归档',
    rawUserPrompt: '按章节拆分成数学基础、运动学、力学三份独立分册',
    multiVolumeDetection: detection,
  });

  assert.equal(plan.isMultiVolume, true);
  assert.equal(plan.volumes?.length, 3);
  assert.equal(plan.batches.length, 7);

  const artifacts = computeVolumeArtifactsFromBatches({
    plan,
    batches: plan.batches.map((b) => ({
      batchIndex: b.batchIndex,
      title: b.title,
      volumeId: b.volumeId,
      volumeIndex: b.volumeIndex,
      status: 'completed',
      continuationCount: 1,
      markdownContent: `# ${b.title}\n\nRigorous derivation with $E = mc^2$.`,
    })),
    defaultMode: 'lecture_notes',
    jobStage: 'completed',
  });

  assert.equal(artifacts.length, 3);
  assert.ok(artifacts.every((a) => a.status === 'completed' && a.charCount > 0));
});

test('buildTokenEfficientExecutionContext dramatically trims continuation context vs initial batch start', () => {
  const bigEarlierText = Array.from(
    { length: 40 },
    (_, i) => `# 第 ${i + 1} 节 核心推导\n\n**定理 ${i + 1}.1** 设向量场 $\\mathbf{F}(x)$ 满足散度定理。\n\n` + '严密推导步骤展开文字。'.repeat(220)
  ).join('\n\n');

  const mockJob = {
    id: 'job-test-1',
    mode: 'lecture_notes' as const,
    rawUserPrompt: '撰写场论与张量分析深度讲义',
    enableHistoricalMemory: true,
    scannedLinks: [],
    supplementalDirectives: [],
  };

  const initialPack = buildTokenEfficientExecutionContext({
    isContinuation: false,
    job: mockJob,
    completedEarlierBatchTexts: [bigEarlierText],
    allUserJobs: [],
  });

  const continuationPack = buildTokenEfficientExecutionContext({
    isContinuation: true,
    job: mockJob,
    completedEarlierBatchTexts: [bigEarlierText],
    allUserJobs: [],
  });

  // Continuation memoryContextBlock only carries the ultra-lean heading/anchor/symbol ledger (~1-2k chars), saving >85% vs initial!
  assert.ok(continuationPack.memoryContextBlock.length < 2500);
  assert.ok(
    continuationPack.memoryContextBlock.length < initialPack.memoryContextBlock.length * 0.2
  );
  assert.ok(continuationPack.memoryContextBlock.includes('定理'));
});
