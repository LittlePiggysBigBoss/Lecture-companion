import type {
  ColorPaletteTheme,
  DepthPreset,
  DocMode,
  GeneratedFigureAsset,
  ModelUsageStat,
  ModuleSpecialistRole,
  ToolModelRegistryEntry,
  VisualFigureSpec,
  VolumeRole,
} from '../types.ts';
import { BATCH_COMPLETE_MARKER } from './pipelineLogic.ts';

/**
 * Quality-First Moderate Per-Call Output Targets (in Chinese chars / English words).
 * Instead of pushing every single model call to extreme 10k–14k ceilings (which risks
 * late-pass proof shortcuts or mid-equation MAX_TOKENS cutoffs), each modular call targets
 * a high-precision sweet spot (3,600–5,800 chars) and stitches all modules cleanly at the end.
 */
export const QUALITY_SWEET_SPOT_WORDS_BY_DEPTH: Record<DepthPreset, number> = {
  standard: 3600,
  comprehensive: 4800,
  exhaustive: 5800,
};

export const QUALITY_SWEET_SPOT_BOUNDS_BY_DEPTH: Record<
  DepthPreset,
  { min: number; max: number }
> = {
  standard: { min: 2400, max: 4400 },
  comprehensive: { min: 3200, max: 5600 },
  exhaustive: { min: 3800, max: 6600 },
};

export function clampModuleWordsToQualitySweetSpot(
  rawTargetWords: number | undefined,
  depth: DepthPreset
): number {
  const defaultTarget = QUALITY_SWEET_SPOT_WORDS_BY_DEPTH[depth];
  const bounds = QUALITY_SWEET_SPOT_BOUNDS_BY_DEPTH[depth];
  const numeric = Number(rawTargetWords);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return defaultTarget;
  }
  return Math.max(bounds.min, Math.min(bounds.max, Math.round(numeric)));
}

/**
 * Full Document-Production Tool-Model Library (`工具模型库`).
 * Orchestrated by Master Thinking Model `gemini-4-carbon` to dispatch each workflow stage
 * and document section to its highest-efficiency specialist model.
 */
export const DOCUMENT_TOOL_MODEL_REGISTRY: readonly ToolModelRegistryEntry[] = [
  {
    modelId: 'gemini-4-carbon',
    codeName: 'Carbon',
    displayName: 'Gemini 4 Carbon（主思考与总控编排模型）',
    family: 'reasoning_core',
    modality: 'text_reasoning',
    primaryRoles: ['orchestration_and_proof'],
    bestForSummary:
      '全局大纲拆解、多模型按需路由调度、核心公理体系构建、高难度压轴定理严密证明与跨模块一致性统稿',
    workflowStages: ['总纲规划与模型路由', '核心定理严密证明', '动态需求重编排'],
    relativeTokenCostIndex: 1.0,
    recommendedMaxWordsPerCall: 5200,
    supportsThinkingLevels: ['LOW', 'MEDIUM', 'HIGH'],
    activeInPipeline: true,
  },
  {
    modelId: 'gemini-4-argon',
    codeName: 'Argon',
    displayName: 'Gemini 4 Argon（数理推导与分级命题专精模型）',
    family: 'reasoning_core',
    modality: 'text_reasoning',
    primaryRoles: ['stem_problem_derivation'],
    bestForSummary:
      '复杂公式分步演算、竞赛与考研分级题组设计、一题多解对比、独立答案册逐题采分标准撰写',
    workflowStages: ['典型例题深度演算', '分级练习题册命题', '独立答案详解分册'],
    relativeTokenCostIndex: 0.62,
    recommendedMaxWordsPerCall: 5600,
    supportsThinkingLevels: ['LOW', 'MEDIUM', 'HIGH'],
    activeInPipeline: true,
  },
  {
    modelId: 'gemini-4-hydrogen',
    codeName: 'Hydrogen',
    displayName: 'Gemini 4 Hydrogen（高吞吐正文与填色排版模型）',
    family: 'efficient_prose',
    modality: 'text_reasoning',
    primaryRoles: ['conceptual_prose_and_color_layout'],
    bestForSummary:
      '清晰流畅的概念动机阐释、物理/几何直觉导引、彩色语义知识框（定义框/定理框/警示框）填色排版与结构化对比表格',
    workflowStages: ['概念背景与直觉精讲', '彩色知识框填色排版', '多维对比表格与小结'],
    relativeTokenCostIndex: 0.28,
    recommendedMaxWordsPerCall: 5800,
    supportsThinkingLevels: ['LOW', 'MEDIUM', 'HIGH'],
    activeInPipeline: true,
  },
  {
    modelId: 'gemini-3.1-flash-lite',
    codeName: 'Flash Lite',
    displayName: 'Gemini 3.1 Flash Lite（极低 Token 衔接与速查索引模型）',
    family: 'efficient_prose',
    modality: 'text_reasoning',
    primaryRoles: ['lean_transition_and_index'],
    bestForSummary:
      '超低成本生成章节导学速览、全局公式符号速查表、跨模块过渡段润色与末尾拼接校验',
    workflowStages: ['全局符号速查表', '跨章节过渡衔接', '终稿拼接格式校验'],
    relativeTokenCostIndex: 0.1,
    recommendedMaxWordsPerCall: 3800,
    supportsThinkingLevels: ['LOW'],
    activeInPipeline: true,
  },
  {
    modelId: 'gemini-nano-banana-2.1',
    codeName: 'Nano Banana 2.1',
    displayName: 'Gemini Nano Banana 2.1（高清科学机理与彩色插图引擎）',
    family: 'nano_banana_vision',
    modality: 'image_generation',
    primaryRoles: ['hd_scientific_illustration'],
    bestForSummary:
      '按需制作 1K/2K 出版级彩色科学机理图、几何子空间变换图、物理受力与场线分析图（自动匹配文档配色主题）',
    workflowStages: ['核心定理几何图解', '复杂物理系统彩色配图', '章节视觉原理图'],
    relativeTokenCostIndex: 0.35,
    activeInPipeline: true,
  },
  {
    modelId: 'gemini-3.1-flash-lite-image',
    codeName: 'Nano Banana Lite',
    displayName: 'Gemini 3.1 Flash Lite Image（快速概念示意图与题图引擎）',
    family: 'nano_banana_vision',
    modality: 'image_generation',
    primaryRoles: ['fast_schematic_diagram'],
    bestForSummary:
      '低延迟、高性价比生成例题/习题配套几何图形、算法状态转移示意图与直观实验装置简图',
    workflowStages: ['例题与训练题配图', '流程与状态示意图', '快速辅助插图'],
    relativeTokenCostIndex: 0.14,
    activeInPipeline: true,
  },
  {
    modelId: 'gemini-3-pro-image',
    codeName: 'Nano Banana Pro',
    displayName: 'Gemini 3 Pro Image（专著封面与高阶视觉图版引擎）',
    family: 'nano_banana_vision',
    modality: 'image_generation',
    primaryRoles: ['studio_cover_visual'],
    bestForSummary:
      '高审美专著导览图版、跨章节知识全景视觉图与复杂多面板学术插画制作',
    workflowStages: ['专著导览视觉图版', '全景知识图谱插画'],
    relativeTokenCostIndex: 0.45,
    activeInPipeline: true,
  },
  {
    modelId: 'gemini-decision-1',
    codeName: 'Decision 1',
    displayName: 'Gemini Decision 1（零输出 Token 校准质量门禁）',
    family: 'multimodal_utility',
    modality: 'calibrated_decision',
    primaryRoles: ['rubric_quality_gate'],
    bestForSummary:
      '基于 Decisions API 对模块公式闭合度、推导无跳步性与排版规范执行零输出 Token 概率校准评估',
    workflowStages: ['模块输出质量门禁', '分册完备性校准判定'],
    relativeTokenCostIndex: 0.08,
    activeInPipeline: true,
  },
  {
    modelId: 'gemini-3.5-transcribe',
    codeName: 'Transcribe 3.5',
    displayName: 'Gemini 3.5 Transcribe（学术语音指令与课堂录音转写引擎）',
    family: 'multimodal_utility',
    modality: 'audio_speech',
    primaryRoles: ['voice_audio_transcribe'],
    bestForSummary:
      '高精度识别中英文夹杂的数学物理专业术语语音录入与课堂录音附件转写',
    workflowStages: ['工作台语音录入需求', '运行中实时语音补充修正'],
    relativeTokenCostIndex: 0.12,
    activeInPipeline: true,
  },
  {
    modelId: 'gemini-embedding-2',
    codeName: 'Embedding 2',
    displayName: 'Gemini Embedding 2（多模态长上下文语义去重与索引引擎）',
    family: 'multimodal_utility',
    modality: 'multimodal_embedding',
    primaryRoles: ['semantic_dedup_embedding'],
    bestForSummary:
      '支持文本、PDF 与图像同空间向量表征，赋能跨历史任务记忆检索与补充指令去重对齐',
    workflowStages: ['长上下文语义索引', '补充需求去重合并'],
    relativeTokenCostIndex: 0.05,
    activeInPipeline: true,
  },
  {
    modelId: 'gemini-3.8-flash-lite-tts',
    codeName: 'Flash Lite TTS 3.8',
    displayName: 'Gemini 3.8 Flash Lite TTS（讲义重点语音导读合成模型）',
    family: 'multimodal_utility',
    modality: 'audio_speech',
    primaryRoles: ['lecture_tts_narration'],
    bestForSummary:
      '支持单讲者或师生双讲者模式合成章节核心定理有声导学音频',
    workflowStages: ['课后重点有声导读扩展'],
    relativeTokenCostIndex: 0.15,
    activeInPipeline: false,
  },
  {
    modelId: 'gemini-omni-1.2-flash',
    codeName: 'Omni Flash 1.2',
    displayName: 'Gemini Omni 1.2 Flash（动态数理过程视频生成与扩展模型）',
    family: 'multimodal_utility',
    modality: 'video_generation',
    primaryRoles: ['dynamic_video_extension'],
    bestForSummary:
      '通过 Interactions API 将静态物理/几何图示扩展为动态连续演化教学短片',
    workflowStages: ['动态物理几何演示扩展'],
    relativeTokenCostIndex: 0.5,
    activeInPipeline: false,
  },
];

export const VALID_TEXT_GENERATION_MODELS = new Set<string>([
  'gemini-4-carbon',
  'gemini-4-argon',
  'gemini-4-hydrogen',
  'gemini-3.1-flash-lite',
]);

export const VALID_IMAGE_GENERATION_MODELS = new Set<string>([
  'gemini-nano-banana-2.1',
  'gemini-3.1-flash-lite-image',
  'gemini-3-pro-image',
]);

export function getToolModelEntry(modelId: string | undefined): ToolModelRegistryEntry {
  const found = DOCUMENT_TOOL_MODEL_REGISTRY.find((m) => m.modelId === modelId);
  return found || DOCUMENT_TOOL_MODEL_REGISTRY[0];
}

export interface ColorPaletteSpec {
  id: ColorPaletteTheme;
  label: string;
  description: string;
  accentHex: string;
  coverBgHex: string;
  coverBorderHex: string;
  coverTitleHex: string;
  h1BorderHex: string;
  tableHeaderBgHex: string;
  tableHeaderTextHex: string;
  imagePromptPaletteHint: string;
  callouts: {
    theorem: { label: string; headerBg: string; bodyBg: string; border: string; titleColor: string };
    definition: { label: string; headerBg: string; bodyBg: string; border: string; titleColor: string };
    example: { label: string; headerBg: string; bodyBg: string; border: string; titleColor: string };
    warning: { label: string; headerBg: string; bodyBg: string; border: string; titleColor: string };
    summary: { label: string; headerBg: string; bodyBg: string; border: string; titleColor: string };
  };
}

export const COLOR_PALETTE_THEMES: Record<ColorPaletteTheme, ColorPaletteSpec> = {
  academic_blue: {
    id: 'academic_blue',
    label: '学术皇家蓝',
    description: '经典 Springer / MIT 教材配色：皇家蓝定理框、靛青定义框与翠绿例题演算框',
    accentHex: '#1d4ed8',
    coverBgHex: '#eff6ff',
    coverBorderHex: '#bfdbfe',
    coverTitleHex: '#0f172a',
    h1BorderHex: '#bfdbfe',
    tableHeaderBgHex: '#eff6ff',
    tableHeaderTextHex: '#1e3a8a',
    imagePromptPaletteHint:
      'clean white textbook background, crisp royal blue (#1D4ED8), slate navy (#0F172A), and soft teal (#0D9488) vector diagram accents',
    callouts: {
      theorem: {
        label: '核心定理 / 命题',
        headerBg: '#dbeafe',
        bodyBg: '#f8fbff',
        border: '#93c5fd',
        titleColor: '#1e3a8a',
      },
      definition: {
        label: '严格定义 / 公理',
        headerBg: '#e0e7ff',
        bodyBg: '#f9faff',
        border: '#a5b4fc',
        titleColor: '#312e81',
      },
      example: {
        label: '典型例题与分步演算',
        headerBg: '#d1fae5',
        bodyBg: '#f7fefa',
        border: '#6ee7b7',
        titleColor: '#065f46',
      },
      warning: {
        label: '易错警示与边界条件',
        headerBg: '#fef3c7',
        bodyBg: '#fffdf5',
        border: '#fcd34d',
        titleColor: '#92400e',
      },
      summary: {
        label: '方法总结与速查要点',
        headerBg: '#f1f5f9',
        bodyBg: '#f8fafc',
        border: '#cbd5e1',
        titleColor: '#0f172a',
      },
    },
  },
  emerald_science: {
    id: 'emerald_science',
    label: '自然科学翠绿',
    description: '现代物理、生物与概率统计教材风格：松石翠绿主调配青蓝定义框与琥珀提示框',
    accentHex: '#047857',
    coverBgHex: '#ecfdf5',
    coverBorderHex: '#a7f3d0',
    coverTitleHex: '#064e3b',
    h1BorderHex: '#a7f3d0',
    tableHeaderBgHex: '#ecfdf5',
    tableHeaderTextHex: '#065f46',
    imagePromptPaletteHint:
      'clean white scientific textbook background, emerald green (#047857), deep teal (#0F766E), and slate (#1E293B) technical diagram lines',
    callouts: {
      theorem: {
        label: '核心定理 / 守恒律',
        headerBg: '#d1fae5',
        bodyBg: '#f6fef9',
        border: '#6ee7b7',
        titleColor: '#064e3b',
      },
      definition: {
        label: '基本定义 / 物理量',
        headerBg: '#ccfbf1',
        bodyBg: '#f5fffe',
        border: '#5eead4',
        titleColor: '#115e59',
      },
      example: {
        label: '建模例题与解析推导',
        headerBg: '#e0f2fe',
        bodyBg: '#f7fcff',
        border: '#7dd3fc',
        titleColor: '#075985',
      },
      warning: {
        label: '实验与审题易错陷阱',
        headerBg: '#fef3c7',
        bodyBg: '#fffdf5',
        border: '#fcd34d',
        titleColor: '#92400e',
      },
      summary: {
        label: '章节规律归纳卡',
        headerBg: '#f1f5f9',
        bodyBg: '#f8fafc',
        border: '#cbd5e1',
        titleColor: '#0f172a',
      },
    },
  },
  amber_olympiad: {
    id: 'amber_olympiad',
    label: '竞赛琥珀金',
    description: '奥赛培优与高阶刷题册配色：暖琥珀考点框、深蓝压轴定理框与清晰采分点高亮',
    accentHex: '#b45309',
    coverBgHex: '#fffbeb',
    coverBorderHex: '#fde68a',
    coverTitleHex: '#78350f',
    h1BorderHex: '#fde68a',
    tableHeaderBgHex: '#fef3c7',
    tableHeaderTextHex: '#78350f',
    imagePromptPaletteHint:
      'clean white olympiad workbook background, crisp dark slate (#0F172A), warm amber gold (#D97706), and cobalt blue (#2563EB) geometric annotations',
    callouts: {
      theorem: {
        label: '竞赛核心定理 / 引理',
        headerBg: '#fef3c7',
        bodyBg: '#fffdf7',
        border: '#fbbf24',
        titleColor: '#78350f',
      },
      definition: {
        label: '命题定义与符号约定',
        headerBg: '#dbeafe',
        bodyBg: '#f8fbff',
        border: '#93c5fd',
        titleColor: '#1e3a8a',
      },
      example: {
        label: '真题变式与采分详解',
        headerBg: '#dcfce7',
        bodyBg: '#f7fef9',
        border: '#86efac',
        titleColor: '#14532d',
      },
      warning: {
        label: '失分重灾区警示',
        headerBg: '#fee2e2',
        bodyBg: '#fffafa',
        border: '#fca5a5',
        titleColor: '#991b1b',
      },
      summary: {
        label: '解题破题套路速记',
        headerBg: '#f1f5f9',
        bodyBg: '#f8fafc',
        border: '#cbd5e1',
        titleColor: '#0f172a',
      },
    },
  },
  burgundy_editorial: {
    id: 'burgundy_editorial',
    label: '经典酒红书刊',
    description: '剑桥/牛津古典学术专著印装风格：典雅酒红主标题与柔和暖灰知识填色框',
    accentHex: '#9f1239',
    coverBgHex: '#fff1f2',
    coverBorderHex: '#fecdd3',
    coverTitleHex: '#881337',
    h1BorderHex: '#fecdd3',
    tableHeaderBgHex: '#ffe4e6',
    tableHeaderTextHex: '#881337',
    imagePromptPaletteHint:
      'clean ivory-white academic monograph background, burgundy crimson (#9F1239), charcoal ink (#1E293B), and muted slate blue (#475569) diagram lines',
    callouts: {
      theorem: {
        label: '基本定理 / 推论',
        headerBg: '#ffe4e6',
        bodyBg: '#fffafb',
        border: '#fda4af',
        titleColor: '#881337',
      },
      definition: {
        label: '范畴与严格定义',
        headerBg: '#f1f5f9',
        bodyBg: '#f8fafc',
        border: '#94a3b8',
        titleColor: '#0f172a',
      },
      example: {
        label: '经典算例与证明剖析',
        headerBg: '#e0e7ff',
        bodyBg: '#f9faff',
        border: '#a5b4fc',
        titleColor: '#312e81',
      },
      warning: {
        label: '反例辨析与适用前提',
        headerBg: '#fef3c7',
        bodyBg: '#fffdf5',
        border: '#fcd34d',
        titleColor: '#92400e',
      },
      summary: {
        label: '文献脉络与核心提要',
        headerBg: '#f3f4f6',
        bodyBg: '#f9fafb',
        border: '#d1d5db',
        titleColor: '#1f2937',
      },
    },
  },
};

export function resolveColorPaletteSpec(theme?: ColorPaletteTheme): ColorPaletteSpec {
  if (theme && theme in COLOR_PALETTE_THEMES) {
    return COLOR_PALETTE_THEMES[theme];
  }
  return COLOR_PALETTE_THEMES.academic_blue;
}

/**
 * Validates Carbon's model assignment or deterministically selects the highest-efficiency
 * specialist model from `DOCUMENT_TOOL_MODEL_REGISTRY` based on the module's pedagogical task.
 */
export function routeSpecialistModelForBatch(params: {
  batchIndex: number;
  totalBatches: number;
  title: string;
  scopeSummary: string;
  sections: string[];
  mode: DocMode;
  volumeRole?: VolumeRole;
  requestedModelId?: string;
  requestedRole?: string;
  requestedReason?: string;
}): {
  assignedModelId: string;
  specialistRole: ModuleSpecialistRole;
  dispatchReason: string;
} {
  const combinedText = `${params.title} ${params.scopeSummary} ${params.sections.join(' ')}`;

  // 1. Honor Carbon's explicit model choice if it is a valid text generation specialist in our registry
  if (
    params.requestedModelId &&
    VALID_TEXT_GENERATION_MODELS.has(params.requestedModelId)
  ) {
    const entry = getToolModelEntry(params.requestedModelId);
    const validRole: ModuleSpecialistRole =
      params.requestedRole === 'orchestration_and_proof' ||
      params.requestedRole === 'stem_problem_derivation' ||
      params.requestedRole === 'conceptual_prose_and_color_layout' ||
      params.requestedRole === 'lean_transition_and_index'
        ? params.requestedRole
        : entry.primaryRoles[0];

    return {
      assignedModelId: entry.modelId,
      specialistRole: validRole,
      dispatchReason:
        params.requestedReason?.trim() ||
        `Carbon 调度 ${entry.codeName}：${entry.bestForSummary.slice(0, 46)}`,
    };
  }

  // 2. Deterministic specialist routing based on module content & role
  if (
    params.volumeRole === 'solutions_manual' ||
    params.mode === 'workbook' ||
    /题组|习题|练习题|真题|压轴题|分步解析|评分标准|答案详解|多解|演算|计算推导/i.test(combinedText)
  ) {
    // Use Carbon for extreme olympiad proof finals, Argon for structured STEM problem sets & step-by-step solutions
    if (/压轴证明|存在唯一性严密证明|公理化证明|谱定理证明/.test(combinedText) && params.mode !== 'workbook') {
      return {
        assignedModelId: 'gemini-4-carbon',
        specialistRole: 'orchestration_and_proof',
        dispatchReason:
          'Carbon 自留核心压轴证明模块：调用最高阶数学逻辑推理确保无跳步严密证明',
      };
    }
    return {
      assignedModelId: 'gemini-4-argon',
      specialistRole: 'stem_problem_derivation',
      dispatchReason:
        'Carbon 调度 Argon 数理专精模型：高效执行多梯度题组设计、分步公式演算与采分点拆解（节省约 38% Token 成本）',
    };
  }

  if (
    /严密证明|存在性证明|唯一性定理|收敛性证明|对偶定理证明|完备性证明|引理推导/i.test(
      combinedText
    )
  ) {
    return {
      assignedModelId: 'gemini-4-carbon',
      specialistRole: 'orchestration_and_proof',
      dispatchReason:
        'Carbon 主模型执笔核心定理证明板块：保障复杂代数/分析推导链条 100% 严密闭合',
    };
  }

  if (
    /速查表|符号索引|术语表|附录汇总|公式卡片|目录导览/i.test(combinedText) &&
    params.totalBatches >= 3 &&
    params.batchIndex === params.totalBatches
  ) {
    return {
      assignedModelId: 'gemini-3.1-flash-lite',
      specialistRole: 'lean_transition_and_index',
      dispatchReason:
        'Carbon 调度 Flash Lite 极速轻量模型：以 10% 级超低 Token 开销完成附录符号速查表与汇总索引',
    };
  }

  // Conceptual exposition, intuitive motivation, structured color callout boxes & tables -> Hydrogen!
  return {
    assignedModelId: 'gemini-4-hydrogen',
    specialistRole: 'conceptual_prose_and_color_layout',
    dispatchReason:
      'Carbon 调度 Hydrogen 高吞吐排版模型：专精概念直觉阐释、彩色知识框填色排版与结构化对比表（节省约 72% Token 成本）',
  };
}

/**
 * Normalizes or synthesizes optional Nano Banana visual figure specs for a module when
 * `autoGenerateFigures` is enabled. Keeps image count disciplined (0–1 crisp figure per module,
 * max 2 when user explicitly asks for rich illustrations) so diagrams genuinely elevate comprehension.
 */
export function normalizeModuleVisualFigures(params: {
  batchIndex: number;
  title: string;
  scopeSummary: string;
  sections: string[];
  mode: DocMode;
  volumeRole?: VolumeRole;
  colorTheme?: ColorPaletteTheme;
  autoGenerateFigures?: boolean;
  rawVisualFigures?: unknown;
}): VisualFigureSpec[] {
  if (params.autoGenerateFigures === false) {
    return [];
  }
  // Solutions-only manuals usually focus on step-by-step equations unless explicitly planned
  const palette = resolveColorPaletteSpec(params.colorTheme);

  if (Array.isArray(params.rawVisualFigures) && params.rawVisualFigures.length > 0) {
    return (params.rawVisualFigures as Array<Record<string, unknown>>)
      .slice(0, 2)
      .map((vf, idx) => {
        const figId = String(vf.figureId || `fig-${params.batchIndex}-${idx + 1}`).replace(
          /[^a-zA-Z0-9_-]/g,
          '-'
        );
        const rawAspect = String(vf.aspectRatio || '16:9');
        const validAspect: VisualFigureSpec['aspectRatio'] =
          rawAspect === '16:9' || rawAspect === '4:3' || rawAspect === '1:1' || rawAspect === '3:4'
            ? rawAspect
            : '16:9';

        const rawImgModel = String(vf.assignedImageModelId || '');
        const validImgModel: VisualFigureSpec['assignedImageModelId'] =
          rawImgModel === 'gemini-nano-banana-2.1' ||
          rawImgModel === 'gemini-3.1-flash-lite-image' ||
          rawImgModel === 'gemini-3-pro-image'
            ? rawImgModel
            : idx === 0 && params.batchIndex === 1
              ? 'gemini-nano-banana-2.1'
              : 'gemini-3.1-flash-lite-image';

        const basePrompt = String(
          vf.prompt ||
            `Educational academic textbook diagram illustrating "${params.title}" (${params.sections[0] || ''}). Crisp geometric vectors, clear English/symbolic mathematical labels, flat high-contrast pedagogical infographic style.`
        );

        return {
          figureId: figId,
          caption: String(
            vf.caption || `图 ${params.batchIndex}.${idx + 1}：${params.title}核心机理与几何直观示意图`
          ),
          prompt: `${basePrompt}. Visual style: ${palette.imagePromptPaletteHint}, publication-ready scientific diagram, no messy clutter, no watermarks.`,
          aspectRatio: validAspect,
          assignedImageModelId: validImgModel,
          placementSectionHint: vf.placementSectionHint
            ? String(vf.placementSectionHint)
            : params.sections[0],
        };
      });
  }

  // Synthesize 1 high-value figure for the opening conceptual/theorem module of a lecture or visual workbook
  if (params.volumeRole === 'solutions_manual') {
    return [];
  }
  if (params.batchIndex === 1 || /几何|图解|受力|场线|网络流|状态转移|分布|电路|光学|结构/i.test(params.title)) {
    const useHdBanana = params.batchIndex === 1;
    return [
      {
        figureId: `fig-${params.batchIndex}-1`,
        caption: `图 ${params.batchIndex}.1：${params.sections[0] || params.title}教学原理与结构示意图`,
        prompt: `Publication-grade university textbook scientific diagram illustrating "${params.title} - ${
          params.sections[0] || params.scopeSummary.slice(0, 80)
        }". Flat crisp educational schematic, clear mathematical/scientific visual structure, ${
          palette.imagePromptPaletteHint
        }, minimalist clean layout suitable for A4 print.`,
        aspectRatio: '16:9',
        assignedImageModelId: useHdBanana
          ? 'gemini-nano-banana-2.1'
          : 'gemini-3.1-flash-lite-image',
        placementSectionHint: params.sections[0],
      },
    ];
  }

  return [];
}

function buildMarkdownFigureEmbed(fig: GeneratedFigureAsset): string {
  const cleanCaption = fig.caption.replace(/\r?\n/g, ' ').trim();
  const modelEntry = getToolModelEntry(fig.modelUsed);
  return `\n\n![${cleanCaption}](${fig.mediaUrl} "${modelEntry.codeName}")\n*${cleanCaption}（由 ${modelEntry.codeName} 视觉模型按需绘制）*\n\n`;
}

/**
 * Injects generated Nano Banana figures into a module's Markdown at exact `{{FIGURE:fig-id}}`
 * placeholders, or cleanly after the opening section's introductory paragraph if the text model
 * omitted the placeholder token. Also strips any unfulfilled `{{FIGURE:...}}` tags.
 */
export function injectGeneratedFiguresIntoModuleMarkdown(
  rawModuleMarkdown: string,
  figures: GeneratedFigureAsset[] = []
): string {
  let working = rawModuleMarkdown.replaceAll(BATCH_COMPLETE_MARKER, '').trim();
  if (!working) return '';

  for (const fig of figures) {
    const embedBlock = buildMarkdownFigureEmbed(fig);
    const exactPlaceholderRegex = new RegExp(
      `\\{\\{\\s*FIGURE\\s*:\\s*${fig.figureId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\}\\}`,
      'gi'
    );

    if (exactPlaceholderRegex.test(working)) {
      working = working.replace(exactPlaceholderRegex, embedBlock);
    } else if (!working.includes(fig.mediaUrl)) {
      // Insert naturally after the first paragraph following a heading so it never splits a math block
      const paragraphs = working.split(/\n{2,}/);
      let insertAfterIdx = Math.min(1, paragraphs.length - 1);
      for (let idx = 0; idx < paragraphs.length; idx++) {
        const p = paragraphs[idx].trim();
        if (
          idx > 0 &&
          !p.startsWith('#') &&
          !p.startsWith('$$') &&
          !p.startsWith(':::') &&
          p.length >= 40
        ) {
          insertAfterIdx = idx;
          break;
        }
      }
      paragraphs.splice(insertAfterIdx + 1, 0, embedBlock.trim());
      working = paragraphs.join('\n\n');
    }
  }

  // Strip any leftover {{FIGURE:...}} placeholders whose image generation was skipped
  working = working.replace(/\{\{\s*FIGURE\s*:\s*[^}]+\}\}/gi, '');
  return working.replace(/\n{4,}/g, '\n\n\n').trim();
}

/**
 * Seamlessly stitches multiple quality-sized modular Markdown outputs into one cohesive,
 * publication-ready document:
 * 1. Injects each module's generated Nano Banana illustrations.
 * 2. Closes any accidentally unclosed `:::` color callout fence or ``` code fence at module boundaries.
 * 3. Deduplicates identical boundary headings if module K+1 repeated module K's trailing heading.
 */
export function stitchModularSectionsIntoDocument(params: {
  modules: Array<{
    batchIndex: number;
    markdownContent: string;
    generatedFigures?: GeneratedFigureAsset[];
  }>;
}): string {
  const cleanedPieces: string[] = [];
  let lastTrailingHeading = '';

  for (const mod of params.modules) {
    let piece = injectGeneratedFiguresIntoModuleMarkdown(
      mod.markdownContent,
      mod.generatedFigures || []
    );
    if (!piece) continue;

    // Ensure any unclosed semantic color callout fence `:::theorem ...` is closed cleanly before next module
    const fenceMatches = piece.match(/^:::[a-zA-Z]*/gm) || [];
    let openCalloutDepth = 0;
    for (const line of piece.split('\n')) {
      const trimmed = line.trim();
      if (/^:::(theorem|definition|example|warning|summary|proof|insight|callout)\b/i.test(trimmed)) {
        openCalloutDepth += 1;
      } else if (trimmed === ':::' && openCalloutDepth > 0) {
        openCalloutDepth -= 1;
      }
    }
    if (fenceMatches.length > 0 && openCalloutDepth > 0) {
      piece = `${piece}\n:::\n`;
    }

    // Deduplicate accidental repeated top-of-module heading matching previous module's last heading
    const lines = piece.split('\n');
    const firstNonEmptyIdx = lines.findIndex((l) => l.trim().length > 0);
    if (firstNonEmptyIdx >= 0) {
      const firstLine = lines[firstNonEmptyIdx].trim();
      if (
        /^#{1,3}\s+/.test(firstLine) &&
        lastTrailingHeading &&
        firstLine.replace(/\s+/g, '') === lastTrailingHeading.replace(/\s+/g, '')
      ) {
        lines.splice(firstNonEmptyIdx, 1);
        piece = lines.join('\n').trim();
      }
    }

    const headingMatches = piece.match(/^#{1,3}\s+.+$/gm);
    if (headingMatches && headingMatches.length > 0) {
      lastTrailingHeading = headingMatches[headingMatches.length - 1].trim();
    }

    if (piece) {
      cleanedPieces.push(piece);
    }
  }

  return cleanedPieces.join('\n\n').replace(/\n{4,}/g, '\n\n\n').trim();
}

/**
 * Computes real weighted token cost savings (%) achieved by Carbon's multi-model routing
 * (`Hydrogen` @ 0.28x, `Argon` @ 0.62x, `Flash Lite` @ 0.10x) compared to running every
 * single module on 100% `gemini-4-carbon` (1.00x).
 */
export function computeMultiModelTokenCostSavingsPct(
  usageList: ModelUsageStat[] | undefined
): number {
  if (!usageList || usageList.length === 0) return 0;

  let baselineCarbonWeightedTokens = 0;
  let actualWeightedTokens = 0;

  for (const stat of usageList) {
    const totalTok = (stat.inputTokens || 0) + (stat.outputTokens || 0);
    if (totalTok <= 0) continue;
    const entry = getToolModelEntry(stat.modelId);
    baselineCarbonWeightedTokens += totalTok * 1.0;
    actualWeightedTokens += totalTok * entry.relativeTokenCostIndex;
  }

  if (baselineCarbonWeightedTokens <= 0 || actualWeightedTokens >= baselineCarbonWeightedTokens) {
    return 0;
  }

  return Math.min(
    78,
    Math.max(
      0,
      Math.round(
        ((baselineCarbonWeightedTokens - actualWeightedTokens) / baselineCarbonWeightedTokens) * 100
      )
    )
  );
}
