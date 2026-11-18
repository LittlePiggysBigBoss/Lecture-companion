import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BATCH_COMPLETE_MARKER,
  buildDriveArchivePath,
  calculateJobProgress,
  computeResumeDescriptor,
  countAcademicMetrics,
  evaluateBatchContinuation,
  mergeContinuationMarkdown,
  normalizePdfFileName,
  reconcileJobsWithServer,
  sanitizeFolderSegment,
  splitMarkdownIntoSemanticBlocks,
} from './pipelineLogic';
import type { PipelineJob } from '../types';

test('sanitizeFolderSegment removes illegal path chars and preserves CJK', () => {
  assert.equal(sanitizeFolderSegment('高等数学: 微积分/线性代数*讲义?'), '高等数学 微积分 线性代数 讲义');
  assert.equal(sanitizeFolderSegment('   ', '默认分类'), '默认分类');
});

test('buildDriveArchivePath constructs 3-level folder hierarchy accurately', () => {
  const lecturePath = buildDriveArchivePath({
    rootFolder: 'Carbon 学术归档',
    subjectCategory: '机器学习与优化',
    mode: 'lecture_notes',
  });
  assert.equal(lecturePath.fullPath, 'Carbon 学术归档 / 机器学习与优化 / 课程讲义 (Lecture Notes)');

  const workbookPath = buildDriveArchivePath({
    rootFolder: '我的题库',
    subjectCategory: '概率论与数理统计',
    mode: 'workbook',
  });
  assert.equal(workbookPath.category, '练习题册 (Workbooks)');
  assert.equal(workbookPath.fullPath, '我的题库 / 概率论与数理统计 / 练习题册 (Workbooks)');
});

test('normalizePdfFileName strips illegal symbols and enforces .pdf suffix', () => {
  assert.equal(normalizePdfFileName('第3讲：凸优化与拉格朗日对偶.pdf', 'lecture_notes'), '第3讲：凸优化与拉格朗日对偶.pdf');
  assert.equal(normalizePdfFileName('Linear Algebra: SVD/PCA', 'workbook'), 'Linear Algebra SVD PCA.pdf');
});

test('evaluateBatchContinuation triggers continuation on MAX_TOKENS or unclosed math block', () => {
  const completed = evaluateBatchContinuation(
    `## 第一章 导论\n内容完整。\n${BATCH_COMPLETE_MARKER}`,
    'STOP',
    0
  );
  assert.equal(completed.shouldContinue, false);
  assert.equal(completed.cleanText.includes(BATCH_COMPLETE_MARKER), false);

  const truncatedByTokens = evaluateBatchContinuation(
    '## 第二章 推导\n根据柯西不等式可得未完待续',
    'MAX_TOKENS',
    1
  );
  assert.equal(truncatedByTokens.shouldContinue, true);
  assert.ok(truncatedByTokens.tailAnchor.includes('根据柯西不等式'));

  const unclosedMath = evaluateBatchContinuation(
    '## 定理证明\n$$\n\\int_0^\\infty e^{-x^2} dx =',
    'STOP',
    0
  );
  assert.equal(unclosedMath.shouldContinue, true);

  const deepContinuation = evaluateBatchContinuation('超长章节继续推导', 'MAX_TOKENS', 7);
  assert.equal(deepContinuation.shouldContinue, true);

  const cappedOut = evaluateBatchContinuation('未完成文本', 'MAX_TOKENS', 12);
  assert.equal(cappedOut.shouldContinue, false);
});

test('mergeContinuationMarkdown deduplicates repeated overlap smoothly', () => {
  const base = '定理 2.1 表明，对于任意实对称矩阵 $A \\in \\mathbb{R}^{n\\times n}$，其特征值均为实数，且不同特征值对应的特征向量正交。';
  const incoming = '且不同特征值对应的特征向量正交。\n\n进一步地，存在正交矩阵 $Q$ 使得 $A = Q \\Lambda Q^T$。[[BATCH_COMPLETE]]';
  const merged = mergeContinuationMarkdown(base, incoming);

  assert.equal(merged.includes('[[BATCH_COMPLETE]]'), false);
  const occurrences = merged.split('且不同特征值对应的特征向量正交。').length - 1;
  assert.equal(occurrences, 1);
  assert.ok(merged.includes('存在正交矩阵 $Q$'));
});

test('calculateJobProgress maps stages and batch completion monotonically', () => {
  const planning = calculateJobProgress({ stage: 'planning', batches: [] });
  assert.equal(planning.percent, 8);

  const midExec = calculateJobProgress({
    stage: 'executing',
    batches: [
      { status: 'completed', continuationCount: 1, markdownContent: 'done' },
      { status: 'running', continuationCount: 0, markdownContent: 'x'.repeat(2250) },
    ],
  });
  assert.ok(midExec.percent > 50 && midExec.percent < 86);
  assert.equal(midExec.completedBatches, 1);
  assert.equal(midExec.totalContinuations, 1);

  const finished = calculateJobProgress({
    stage: 'completed',
    batches: [
      { status: 'completed', continuationCount: 2, markdownContent: 'done 1' },
      { status: 'completed', continuationCount: 0, markdownContent: 'done 2' },
    ],
  });
  assert.equal(finished.percent, 100);
  assert.equal(finished.totalContinuations, 2);
});

test('splitMarkdownIntoSemanticBlocks keeps headings paired and math/tables intact', () => {
  const sample = [
    '# 第一讲 奇异值分解',
    '',
    '奇异值分解是矩阵分析的核心工具。',
    '',
    '$$',
    'A = U \\Sigma V^T',
    '$$',
    '',
    '| 符号 | 维度 |',
    '| --- | --- |',
    '| U | m x m |',
  ].join('\n');

  const blocks = splitMarkdownIntoSemanticBlocks(sample);
  assert.equal(blocks.length, 3);
  assert.ok(blocks[0].includes('# 第一讲 奇异值分解') && blocks[0].includes('奇异值分解是矩阵分析的核心工具'));
  assert.ok(blocks[1].startsWith('$$') && blocks[1].endsWith('$$'));
  assert.ok(blocks[2].includes('| U | m x m |'));
});

test('countAcademicMetrics counts CJK + Latin words and LaTeX formulas accurately', () => {
  const md = '# 导论\n设矩阵 $A$ 满足 $Ax=b$。\n\n$$\n\\|Ax - b\\|_2^2\n$$';
  const metrics = countAcademicMetrics(md);
  assert.equal(metrics.formulaCount, 3);
  assert.equal(metrics.sectionCount, 1);
  assert.ok(metrics.charCount >= 10);
  assert.ok(metrics.estimatedPages >= 1);
});

function makeSampleFailedJob(): PipelineJob {
  return {
    id: 'job-err-1',
    createdAt: '2026-11-16T10:00:00.000Z',
    updatedAt: '2026-11-16T10:05:00.000Z',
    mode: 'lecture_notes',
    depth: 'comprehensive',
    rawUserPrompt: '写一份泛函分析巴拿赫空间讲义',
    customRootFolder: 'Carbon 学术归档',
    autoArchiveDrive: true,
    attachmentsMeta: [],
    stage: 'error',
    errorMessage: '网络波动导致流中断',
    plan: {
      documentTitle: '泛函分析：赋范线性空间与巴拿赫空间讲义',
      subtitle: '完备性、压缩映射原理与开映射定理',
      subjectCategory: '泛函分析',
      courseCode: 'MATH-401',
      archiveRootFolder: 'Carbon 学术归档',
      archiveSubjectFolder: '泛函分析',
      suggestedFileName: 'MATH401_泛函分析.pdf',
      expandedPrompt: '扩写大纲',
      pedagogicalGoals: ['掌握巴拿赫空间完备性'],
      batches: [
        {
          batchIndex: 1,
          title: '第一章 赋范空间基础',
          scopeSummary: '定义与完备性',
          sections: ['1.1 范数'],
          estimatedPages: 3,
          targetWords: 2000,
          includeAnswerKey: false,
        },
        {
          batchIndex: 2,
          title: '第二章 三大基本定理',
          scopeSummary: '一致有界与开映射',
          sections: ['2.1 共鸣定理', '2.2 开映射定理'],
          estimatedPages: 4,
          targetWords: 2500,
          includeAnswerKey: false,
        },
      ],
    },
    batches: [
      {
        batchIndex: 1,
        title: '第一章 赋范空间基础',
        status: 'completed',
        continuationCount: 0,
        markdownContent: '# 第一章 赋范空间基础\n第一章已完整生成完毕。',
      },
      {
        batchIndex: 2,
        title: '第二章 三大基本定理',
        status: 'error',
        continuationCount: 1,
        markdownContent: '# 第二章 三大基本定理\n## 2.1 共鸣定理\n设 $X$ 为巴拿赫空间，写到一半断连',
        errorMessage: 'Stream disconnected',
      },
    ],
    compiledMarkdown: '# 第一章...',
    charCount: 120,
    formulaCount: 1,
    estimatedPages: 1,
    driveArchive: { status: 'idle' },
  };
}

test('computeResumeDescriptor preserves completed batches and continues partial text on continue strategy', () => {
  const job = makeSampleFailedJob();
  const resume = computeResumeDescriptor(job, 'continue');
  assert.equal(resume.resumePhase, 'executing');
  assert.equal(resume.startBatchIdx, 1);
  assert.equal(resume.continuePartialBatch, true);
  assert.equal(resume.updatedBatches[0].status, 'completed');
  assert.ok(resume.updatedBatches[1].markdownContent.includes('写到一半断连'));
});

test('computeResumeDescriptor resets only failed batch while preserving earlier batches on retry_batch strategy', () => {
  const job = makeSampleFailedJob();
  const retry = computeResumeDescriptor(job, 'retry_batch');
  assert.equal(retry.resumePhase, 'executing');
  assert.equal(retry.startBatchIdx, 1);
  assert.equal(retry.continuePartialBatch, false);
  assert.equal(retry.updatedBatches[0].status, 'completed');
  assert.ok(retry.updatedBatches[0].markdownContent.includes('第一章已完整生成完毕'));
  assert.equal(retry.updatedBatches[1].markdownContent, '');
});

test('computeResumeDescriptor jumps straight to archiving when all batches already completed', () => {
  const job = makeSampleFailedJob();
  job.batches[1].status = 'completed';
  job.driveArchive = { status: 'error', error: 'Upload timeout' };
  const archiveOnly = computeResumeDescriptor(job, 'continue');
  assert.equal(archiveOnly.resumePhase, 'archiving');
});

test('reconcileJobsWithServer converts orphaned browser-local executing jobs into error state while preserving server_cloud jobs', () => {
  const orphanLocal: PipelineJob = {
    ...makeSampleFailedJob(),
    id: 'orphan-local-1',
    executionHost: 'local',
    stage: 'executing',
    errorMessage: undefined,
  };
  const reconciled = reconcileJobsWithServer([orphanLocal], [], []);
  assert.equal(reconciled.length, 1);
  assert.equal(reconciled[0].stage, 'error');
  assert.ok(reconciled[0].errorMessage?.includes('断点继续'));

  const serverCloudRunning: PipelineJob = {
    ...makeSampleFailedJob(),
    id: 'cloud-running-1',
    executionHost: 'server_cloud',
    stage: 'executing',
    errorMessage: undefined,
  };
  const cloudReconciled = reconcileJobsWithServer([serverCloudRunning], [], []);
  assert.equal(cloudReconciled[0].stage, 'executing');
});

test('evaluateBatchContinuation detects unclosed :::theorem callout blocks and mid-clause stops', () => {
  const unclosedCallout = evaluateBatchContinuation(
    ':::theorem 定理 3.1：高斯定理\n穿过任意闭合曲面的电通量等于该闭合曲面内电荷代数和除以 $\\varepsilon_0$',
    'STOP',
    0
  );
  assert.equal(unclosedCallout.shouldContinue, true);

  const midClause = evaluateBatchContinuation(
    '## 第三节 动量守恒\n将上式两边同时对时间求导可得：',
    'STOP',
    0
  );
  assert.equal(midClause.shouldContinue, true);
});


