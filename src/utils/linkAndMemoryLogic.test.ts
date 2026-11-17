import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildLongContextMemoryPrompt,
  extractAcademicHeadingAndSymbolLedger,
  extractRecognizedLinks,
  windowLongMarkdownContext,
} from './linkAndMemoryLogic';
import type { PipelineJob } from '../types';

test('extractRecognizedLinks cleanly stops before CJK characters glued right after Google Drive sharing link', () => {
  const realUserPrompt =
    'https://drive.google.com/file/d/1GO5puWa4UPIFuh-cl7CkaOgLlgBP-SVB/view?usp=sharing继续撰写完善并升级这份physics bowl讲义，按章节拆分成数学基础，运动学和力学';

  const links = extractRecognizedLinks(realUserPrompt);
  assert.equal(links.length, 1);
  assert.equal(links[0].kind, 'google_drive_file');
  assert.equal(links[0].resourceId, '1GO5puWa4UPIFuh-cl7CkaOgLlgBP-SVB');
  assert.equal(
    links[0].url,
    'https://drive.google.com/file/d/1GO5puWa4UPIFuh-cl7CkaOgLlgBP-SVB/view?usp=sharing'
  );
  assert.ok(links[0].normalizedFetchUrl.includes('1GO5puWa4UPIFuh-cl7CkaOgLlgBP-SVB'));
});

test('extractRecognizedLinks classifies Drive folders, Google Docs, Slides, Sheets, arXiv, GitHub blob, and PDF URLs', () => {
  const input = [
    '参考云盘文件夹：https://drive.google.com/drive/u/0/folders/1AbCdEfGhIjKlMnOpQrStUvWxYz12345，',
    '结合大纲文档 (https://docs.google.com/document/d/1DocId9876543210abcdef/edit?usp=sharing)。',
    '课件链接：https://docs.google.com/presentation/d/1SlideId9876543210abcdef/edit；',
    '成绩表：https://docs.google.com/spreadsheets/d/1SheetId9876543210abcdef/edit',
    '论文参考 https://arxiv.org/abs/2310.06825v2 以及代码 https://github.com/openai/tiktoken/blob/main/README.md',
    '和直链真题 https://mit.edu/8.01/exams/midterm2024.pdf。',
  ].join('\n');

  const links = extractRecognizedLinks(input);
  assert.equal(links.length, 7);
  assert.equal(links[0].kind, 'google_drive_folder');
  assert.equal(links[0].resourceId, '1AbCdEfGhIjKlMnOpQrStUvWxYz12345');

  assert.equal(links[1].kind, 'google_doc');
  assert.equal(
    links[1].normalizedFetchUrl,
    'https://docs.google.com/document/d/1DocId9876543210abcdef/export?format=pdf'
  );

  assert.equal(links[2].kind, 'google_slides');
  assert.equal(links[3].kind, 'google_sheets');

  assert.equal(links[4].kind, 'arxiv_paper');
  assert.equal(links[4].normalizedFetchUrl, 'https://arxiv.org/pdf/2310.06825v2.pdf');

  assert.equal(links[5].kind, 'direct_document');
  assert.equal(
    links[5].normalizedFetchUrl,
    'https://raw.githubusercontent.com/openai/tiktoken/main/README.md'
  );

  assert.equal(links[6].kind, 'direct_document');
  assert.equal(links[6].url, 'https://mit.edu/8.01/exams/midterm2024.pdf');
});

test('extractAcademicHeadingAndSymbolLedger and windowLongMarkdownContext preserve structure and tail continuity', () => {
  const md = [
    '# Chapter 1: Mathematical Foundations',
    '定义 1.1 设位置矢量为 $\\vec{r}(t)$，哈密顿算符为 $\\hat{H}$。',
    '## 1.2 Kinematics in Two Dimensions',
    '**例题 1.4 · 抛体包络线推导**',
    'A'.repeat(5000),
    '### 2.3 Lagrangian Formulation',
    '**题 2.8 · 难度：压轴** 设拉格朗日量为 $\\mathcal{L} = T - V$。',
  ].join('\n');

  const ledger = extractAcademicHeadingAndSymbolLedger(md);
  assert.equal(ledger.headings.length, 3);
  assert.ok(ledger.lastNumberedAnchors.some((a) => a.includes('题 2.8')));
  assert.ok(ledger.symbolHints.includes('\\vec{r}'));
  assert.ok(ledger.symbolHints.includes('\\mathcal{L}'));

  const windowed = windowLongMarkdownContext(md, 1200);
  assert.ok(windowed.includes('# Chapter 1: Mathematical Foundations'));
  assert.ok(windowed.includes('**题 2.8 · 难度：压轴**'));
});

test('buildLongContextMemoryPrompt injects bound parent context, historical memory, scanned links, and earlier batches', () => {
  const parentJob: PipelineJob = {
    id: 'job-parent-1',
    createdAt: '2026-11-16T01:00:00.000Z',
    updatedAt: '2026-11-16T02:00:00.000Z',
    mode: 'lecture_notes',
    depth: 'comprehensive',
    rawUserPrompt: 'Physics Bowl 力学讲义',
    customRootFolder: 'Carbon 学术归档',
    autoArchiveDrive: true,
    attachmentsMeta: [],
    stage: 'completed',
    plan: {
      documentTitle: 'Physics Bowl Mechanics Lecture Notes',
      subtitle: 'Vectors, Kinematics & Newton Laws',
      subjectCategory: '竞赛物理',
      courseCode: 'PHYS-PB1',
      archiveRootFolder: 'Carbon 学术归档',
      archiveSubjectFolder: '竞赛物理',
      suggestedFileName: 'PhysicsBowl_Mechanics.pdf',
      expandedPrompt: 'Rigorous Physics Bowl Div 1 & Div 2 mechanics notes.',
      pedagogicalGoals: ['Master kinematics'],
      batches: [],
    },
    batches: [],
    compiledMarkdown: '# Chapter 1 Kinematics\n\n定理 1.2 相对运动速度合成 $\\vec{v}_{AC} = \\vec{v}_{AB} + \\vec{v}_{BC}$。' + '详细推导内容。'.repeat(200),
    charCount: 1600,
    formulaCount: 12,
    estimatedPages: 6,
    driveArchive: { status: 'archived' },
  };

  const memoryBlock = buildLongContextMemoryPrompt({
    currentJob: {
      id: 'job-derived-2',
      parentJobId: 'job-parent-1',
      sourceContextJobIds: ['job-parent-1'],
      enableHistoricalMemory: true,
      mode: 'workbook',
      rawUserPrompt: '基于已完成讲义生成配套分级题册',
      scannedLinks: [
        {
          url: 'https://drive.google.com/file/d/1GO5puWa4UPIFuh-cl7CkaOgLlgBP-SVB/view',
          normalizedFetchUrl: 'https://drive.usercontent.google.com/download?id=1GO5puWa4UPIFuh-cl7CkaOgLlgBP-SVB',
          kind: 'google_drive_file',
          status: 'ready',
          title: 'PhysicsBowl_PastPaper.pdf',
          size: 409600,
          scannedAt: '2026-11-16T03:00:00.000Z',
        },
      ],
    },
    completedEarlierBatchTexts: ['# 第一部分：运动学基础精练\n\n**题 1.5** 斜抛极值分析。'],
    allUserJobs: [parentJob],
  });

  assert.ok(memoryBlock.includes('PhysicsBowl_PastPaper.pdf'));
  assert.ok(memoryBlock.includes('Physics Bowl Mechanics Lecture Notes'));
  assert.ok(memoryBlock.includes('定理 1.2'));
  assert.ok(memoryBlock.includes('题 1.5'));
});
