import test from 'node:test';
import assert from 'node:assert/strict';
import {
  clampModuleWordsToQualitySweetSpot,
  computeMultiModelTokenCostSavingsPct,
  DOCUMENT_TOOL_MODEL_REGISTRY,
  injectGeneratedFiguresIntoModuleMarkdown,
  normalizeModuleVisualFigures,
  QUALITY_SWEET_SPOT_WORDS_BY_DEPTH,
  resolveColorPaletteSpec,
  routeSpecialistModelForBatch,
  stitchModularSectionsIntoDocument,
} from './modelRegistryAndRouter';

test('DOCUMENT_TOOL_MODEL_REGISTRY includes Carbon, Argon, Hydrogen, Flash Lite, Nano Banana 2.1/Lite/Pro, and utility models', () => {
  const ids = new Set(DOCUMENT_TOOL_MODEL_REGISTRY.map((m) => m.modelId));
  assert.ok(ids.has('gemini-4-carbon'));
  assert.ok(ids.has('gemini-4-argon'));
  assert.ok(ids.has('gemini-4-hydrogen'));
  assert.ok(ids.has('gemini-3.1-flash-lite'));
  assert.ok(ids.has('gemini-nano-banana-2.1'));
  assert.ok(ids.has('gemini-3.1-flash-lite-image'));
  assert.ok(ids.has('gemini-3-pro-image'));
  assert.ok(ids.has('gemini-decision-1'));
  assert.ok(ids.has('gemini-3.5-transcribe'));
  assert.ok(ids.has('gemini-embedding-2'));
  assert.equal(DOCUMENT_TOOL_MODEL_REGISTRY.length, 12);
});

test('clampModuleWordsToQualitySweetSpot enforces moderate quality-first per-call budgets instead of extreme 14k limits', () => {
  assert.equal(QUALITY_SWEET_SPOT_WORDS_BY_DEPTH.standard, 3600);
  assert.equal(QUALITY_SWEET_SPOT_WORDS_BY_DEPTH.comprehensive, 4800);
  assert.equal(QUALITY_SWEET_SPOT_WORDS_BY_DEPTH.exhaustive, 5800);

  // Over-stretched legacy values like 14000 are clamped down to quality sweet-spot max (<= 6600)
  assert.equal(clampModuleWordsToQualitySweetSpot(14000, 'comprehensive'), 5600);
  assert.equal(clampModuleWordsToQualitySweetSpot(14000, 'exhaustive'), 6600);
  assert.equal(clampModuleWordsToQualitySweetSpot(undefined, 'standard'), 3600);
});

test('routeSpecialistModelForBatch dispatches optimal models across proof, STEM problem, prose/color layout, and index tasks', () => {
  const proofRoute = routeSpecialistModelForBatch({
    batchIndex: 2,
    totalBatches: 4,
    title: '第二章：Eckart-Young-Mirsky 定理严密证明',
    scopeSummary: '算子范数与 Frobenius 范数下界的存在性证明与引理推导',
    sections: ['2.1 引理准备', '2.2 核心定理严密证明'],
    mode: 'lecture_notes',
  });
  assert.equal(proofRoute.assignedModelId, 'gemini-4-carbon');
  assert.equal(proofRoute.specialistRole, 'orchestration_and_proof');

  const problemRoute = routeSpecialistModelForBatch({
    batchIndex: 3,
    totalBatches: 4,
    title: '第三章：分级典型例题与压轴题组演算',
    scopeSummary: '包含基础题、进阶计算推导与详细评分标准',
    sections: ['3.1 典型例题', '3.2 进阶练习题与分步解析'],
    mode: 'lecture_notes',
  });
  assert.equal(problemRoute.assignedModelId, 'gemini-4-argon');
  assert.equal(problemRoute.specialistRole, 'stem_problem_derivation');

  const proseLayoutRoute = routeSpecialistModelForBatch({
    batchIndex: 1,
    totalBatches: 4,
    title: '第一章：奇异值分解几何直觉与核心概念填色概览',
    scopeSummary: '背景动机阐释、彩色定义框与三种分解对比表',
    sections: ['1.1 几何动机', '1.2 结构化对比表格'],
    mode: 'lecture_notes',
  });
  assert.equal(proseLayoutRoute.assignedModelId, 'gemini-4-hydrogen');
  assert.equal(proseLayoutRoute.specialistRole, 'conceptual_prose_and_color_layout');

  const liteIndexRoute = routeSpecialistModelForBatch({
    batchIndex: 4,
    totalBatches: 4,
    title: '第四部分：全书符号索引与速查表',
    scopeSummary: '汇总全局矩阵记号与核心公式卡片',
    sections: ['附录 A 符号速查表'],
    mode: 'lecture_notes',
  });
  assert.equal(liteIndexRoute.assignedModelId, 'gemini-3.1-flash-lite');
  assert.equal(liteIndexRoute.specialistRole, 'lean_transition_and_index');
});

test('normalizeModuleVisualFigures assigns Nano Banana 2.1 for key diagrams and honors color palette theme', () => {
  const figs = normalizeModuleVisualFigures({
    batchIndex: 1,
    title: '第一章：正交子空间几何变换',
    scopeSummary: '旋转-拉伸-旋转三步几何图解',
    sections: ['1.1 几何变换分解'],
    mode: 'lecture_notes',
    colorTheme: 'emerald_science',
    autoGenerateFigures: true,
  });

  assert.equal(figs.length, 1);
  assert.equal(figs[0].assignedImageModelId, 'gemini-nano-banana-2.1');
  assert.ok(figs[0].prompt.includes('#047857'));

  const disabledFigs = normalizeModuleVisualFigures({
    batchIndex: 1,
    title: '第一章：正交子空间几何变换',
    scopeSummary: '旋转-拉伸-旋转三步几何图解',
    sections: ['1.1 几何变换分解'],
    mode: 'lecture_notes',
    autoGenerateFigures: false,
  });
  assert.equal(disabledFigs.length, 0);
});

test('stitchModularSectionsIntoDocument injects Nano Banana figures, closes unclosed callouts, and deduplicates boundary headings', () => {
  const stitched = stitchModularSectionsIntoDocument({
    modules: [
      {
        batchIndex: 1,
        markdownContent: `# 第一章 矩阵分解导论\n\n本章介绍核心线性算子几何图像。\n\n{{FIGURE:fig-1-1}}\n\n:::theorem 定理 1.1\n任意实矩阵存在奇异值分解。\n\n## 1.2 过渡小节`,
        generatedFigures: [
          {
            figureId: 'fig-1-1',
            batchIndex: 1,
            caption: '图 1.1：线性变换奇异值主轴伸缩示意图',
            modelUsed: 'gemini-nano-banana-2.1',
            aspectRatio: '16:9',
            mimeType: 'image/png',
            mediaUrl: '/api/jobs/job-demo/media/fig-1-1.png',
            createdAt: '2026-11-17T00:00:00.000Z',
          },
        ],
      },
      {
        batchIndex: 2,
        markdownContent: `## 1.2 过渡小节\n\n紧接上节展开严格算例推导与 $A = U \\Sigma V^T$ 验证。\n\n{{FIGURE:unfulfilled-id}}`,
      },
    ],
  });

  // Figure was injected at {{FIGURE:fig-1-1}}
  assert.ok(stitched.includes('![图 1.1：线性变换奇异值主轴伸缩示意图](/api/jobs/job-demo/media/fig-1-1.png'));
  // Unclosed :::theorem fence from module 1 was safely closed before module 2
  assert.ok(stitched.includes(':::'));
  // Leftover unfulfilled placeholder was stripped cleanly
  assert.ok(!stitched.includes('unfulfilled-id'));
  // Duplicate boundary heading "## 1.2 过渡小节" appears only once!
  const occurrences = stitched.match(/## 1\.2 过渡小节/g) || [];
  assert.equal(occurrences.length, 1);
});

test('computeMultiModelTokenCostSavingsPct calculates weighted token efficiency gain accurately', () => {
  const savings = computeMultiModelTokenCostSavingsPct([
    {
      modelId: 'gemini-4-carbon',
      codeName: 'Carbon',
      roleSummary: '定理证明',
      calls: 1,
      inputTokens: 10000,
      outputTokens: 5000,
    },
    {
      modelId: 'gemini-4-hydrogen',
      codeName: 'Hydrogen',
      roleSummary: '概念阐释与填色排版',
      calls: 2,
      inputTokens: 20000,
      outputTokens: 12000,
    },
    {
      modelId: 'gemini-4-argon',
      codeName: 'Argon',
      roleSummary: '分级题组演算',
      calls: 1,
      inputTokens: 10000,
      outputTokens: 8000,
    },
  ]);

  assert.ok(savings >= 35 && savings <= 55);
  assert.equal(resolveColorPaletteSpec('burgundy_editorial').label, '经典酒红书刊');
});

test('renderAcademicMarkdown preserves KaTeX \\sqrt radical SVG inside color-filled callouts', async () => {
  const { renderAcademicMarkdown } = await import('./markdownMathRenderer');
  const html = renderAcademicMarkdown(
    ':::warning 奇异值非负性\n非零奇异值 $\\sigma_i = \\sqrt{\\lambda_i(A^T A)}$ 恒正。\n:::',
    'academic_blue'
  );
  assert.ok(html.includes('academic-callout'));
  assert.ok(html.includes('width="400em"'));
  assert.ok(!html.includes('style="max-width:100%;height:auto;"'));
});
