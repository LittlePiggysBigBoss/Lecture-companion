import type { DocMode, PipelineJob } from '../types';
import { countAcademicMetrics } from '../utils/pipelineLogic';

export interface StarterTemplate {
  id: string;
  label: string;
  mode: DocMode;
  subjectHint: string;
  prompt: string;
}

export const STARTER_TEMPLATES: StarterTemplate[] = [
  {
    id: 'svd-notes',
    label: '高等线性代数 · SVD 与低秩近似讲义',
    mode: 'lecture_notes',
    subjectHint: '高等线性代数',
    prompt:
      '帮我写一份关于矩阵奇异值分解 (SVD)、几何直觉、Eckart-Young-Mirsky 最优低秩近似定理证明，以及在主成分分析 (PCA) 与图像压缩中应用的深度讲义。',
  },
  {
    id: 'convex-notes',
    label: '凸优化理论 · 拉格朗日对偶与 KKT 条件讲义',
    mode: 'lecture_notes',
    subjectHint: '凸优化与运筹学',
    prompt:
      '整理一份研究生水准的凸优化讲义，涵盖凸集与凸函数判定、拉格朗日对偶函数、强弱对偶性与 Slater 条件、KKT 最优性条件推导及 SVM 对偶求解实例。',
  },
  {
    id: 'prob-workbook',
    label: '概率统计 · 贝叶斯推断与马尔可夫链练习题册',
    mode: 'workbook',
    subjectHint: '概率论与数理统计',
    prompt:
      '生成一套关于共轭先验贝叶斯估计、最大后验概率 (MAP)、大数定律与离散时间马尔可夫链平稳分布的分级练习题册，包含基础题、进阶计算题与压轴证明题，附完整分步答案。',
  },
  {
    id: 'algo-workbook',
    label: '算法设计 · 动态规划与网络流精编题册',
    mode: 'workbook',
    subjectHint: '算法设计与分析',
    prompt:
      '帮我出一本算法竞赛与期末复习用的练习题册，聚焦区间/树形动态规划状态转移方程设计与最大流最小割定理建模，每道题都要有严谨复杂度分析与详细题解。',
  },
  {
    id: 'multi-vol-physics',
    label: '分册独立输出 · 竞赛物理多模块讲义 + 独立解析册',
    mode: 'lecture_notes',
    subjectHint: '竞赛物理',
    prompt:
      '制作一份高阶物理竞赛全套讲义，按章节拆分成数学基础与运动学、牛顿动力学与守恒律两份独立分册文件输出，并且所有例题和配套训练题的答案和详细解析另外一份独立文件输出，不要限制生成轮次，确保推导详尽。',
  },
  {
    id: 'landscape-ppt-rl',
    label: '横版演示 PPT 版式 · 强化学习 MDP 与策略梯度课件',
    mode: 'lecture_notes',
    subjectHint: '机器学习与控制论',
    prompt:
      '整理一份强化学习马尔可夫决策过程 (MDP)、贝尔曼最优方程与策略梯度定理 (Policy Gradient) 的横版 PDF 讲义，调整成横版 PDF 可以当成 PPT 使用的版式，字体大小与结构适合课堂展示呈现，核心定理证明和典型算例完整详尽。',
  },
];

const SEED_SVD_MARKDOWN = `# 第一章 奇异值分解 (SVD) 的代数结构与几何直觉

## 1.1 动机：从特征值分解到任意矩阵的正交对角化

在线性代数中，实对称矩阵 $A \\in \\mathbb{R}^{n \\times n}$ 享有优美的谱定理（Spectral Theorem）：存在正交矩阵 $Q$ 使得 $A = Q \\Lambda Q^T$。然而在数据科学、信号处理与现代机器学习中，观测矩阵往往是非方阵 $A \\in \\mathbb{R}^{m \\times n}$（例如包含 $m$ 个样本、$n$ 维特征的数据矩阵）。奇异值分解（Singular Value Decomposition, SVD）将正交对角化的思想推广到了**任意维度、任意秩**的实矩阵与复矩阵。

:::definition 定义 1.1（奇异值分解 SVD）
设矩阵 $A \\in \\mathbb{R}^{m \\times n}$ 的秩为 $r = \\operatorname{rank}(A) \\le \\min(m, n)$。则存在正交矩阵 $U \\in \\mathbb{R}^{m \\times m}$（左奇异向量矩阵）与正交矩阵 $V \\in \\mathbb{R}^{n \\times n}$（右奇异向量矩阵），使得：

$$A = U \\Sigma V^T = \\sum_{i=1}^{r} \\sigma_i u_i v_i^T$$

其中 $\\Sigma \\in \\mathbb{R}^{m \\times n}$ 仅在主对角线上有非零元素 $\\sigma_1 \\ge \\sigma_2 \\ge \\cdots \\ge \\sigma_r > 0$，其余元素全为 $0$。常数 $\\sigma_i$ 称为矩阵 $A$ 的**奇异值**。
:::

## 1.2 存在性严密证明与格拉姆矩阵联系

考虑对称半正定矩阵 $A^T A \\in \\mathbb{R}^{n \\times n}$。对于任意向量 $x \\in \\mathbb{R}^n$，有二次型非负性：

$$x^T (A^T A) x = (Ax)^T (Ax) = \\|Ax\\|_2^2 \\ge 0$$

由实对称矩阵谱定理，$A^T A$ 存在一组标准正交特征向量基 $\\{v_1, v_2, \\dots, v_n\\}$ 及对应的非负实特征值 $\\lambda_1 \\ge \\lambda_2 \\ge \\cdots \\ge \\lambda_r > \\lambda_{r+1} = \\cdots = \\lambda_n = 0$。令 $\\sigma_i = \\sqrt{\\lambda_i} > 0$（$1 \\le i \\le r$），并构造左奇异向量：

$$u_i = \\frac{1}{\\sigma_i} A v_i, \\quad i = 1, 2, \\dots, r$$

我们验证 $\\{u_1, \\dots, u_r\\}$ 的标准正交性：对于任意 $1 \\le i, j \\le r$，有内积计算：

$$u_i^T u_j = \\frac{1}{\\sigma_i \\sigma_j} v_i^T (A^T A) v_j = \\frac{\\lambda_j}{\\sigma_i \\sigma_j} v_i^T v_j = \\frac{\\sigma_j^2}{\\sigma_i \\sigma_j} \\delta_{ij} = \\delta_{ij}$$

通过施密特正交化将其扩充为 $\\mathbb{R}^m$ 的完整标准正交基 $\\{u_1, \\dots, u_m\\}$，即得 $A V = U \\Sigma$，右乘 $V^T$ 即证得 $A = U \\Sigma V^T$。

| 分解形式 | 矩阵维度配置 | 计算复杂度（假设 $m \\ge n$） | 典型工程应用场景 |
| --- | --- | --- | --- |
| 完全 SVD (Full SVD) | $U \\in \\mathbb{R}^{m\\times m}, \\Sigma \\in \\mathbb{R}^{m\\times n}, V \\in \\mathbb{R}^{n\\times n}$ | $O(m^2 n + m n^2)$ | 零空间分析、最小二乘通解正交基构造 |
| 紧凑 SVD (Thin SVD) | $U_n \\in \\mathbb{R}^{m\\times n}, \\Sigma_n \\in \\mathbb{R}^{n\\times n}, V \\in \\mathbb{R}^{n\\times n}$ | $O(m n^2)$ | QR 预处理回归、条件数数值稳定性分析 |
| 截断 SVD (Truncated-$k$) | $U_k \\in \\mathbb{R}^{m\\times k}, \\Sigma_k \\in \\mathbb{R}^{k\\times k}, V_k \\in \\mathbb{R}^{n\\times k}$ | $O(m n k)$（随机化幂迭代） | 大规模推荐系统、PCA 降维、图像低秩去噪 |

:::warning 易错辨析：特征值分解与奇异值分解的符号与正交性差异
非对称方阵 $A$ 的特征值可能为负数甚至复数，且特征向量未必正交；而任意实矩阵 $A$ 的非零奇异值 $\\sigma_i = \\sqrt{\\lambda_i(A^T A)}$ **恒为严格正实数**，且左右奇异向量系 $\\{u_i\\}$ 与 $\\{v_i\\}$ 各自恒构成标准正交系。
:::

# 第二章 Eckart-Young-Mirsky 最优低秩近似定理与 PCA 应用

## 2.1 最优秩-$k$ 逼近定理与误差精确刻画

在实际高维数据矩阵中，尾部微小奇异值往往对应观测噪声。截断前 $k$ 项秩一矩阵之和记为 $A_k = \\sum_{i=1}^{k} \\sigma_i u_i v_i^T$（其中 $k < r$）。

:::theorem 定理 2.1（Eckart-Young-Mirsky 最优低秩近似定理）
对于任意秩不超过 $k$ 的矩阵 $B \\in \\mathbb{R}^{m \\times n}$（即 $\\operatorname{rank}(B) \\le k$），截断奇异值矩阵 $A_k$ 在谱范数（算子 2-范数）与 Frobenius 范数下均达到全局最小逼近误差：

$$\\min_{\\operatorname{rank}(B) \\le k} \\|A - B\\|_2 = \\|A - A_k\\|_2 = \\sigma_{k+1}$$

$$\\min_{\\operatorname{rank}(B) \\le k} \\|A - B\\|_F = \\|A - A_k\\|_F = \\sqrt{\\sum_{i=k+1}^{r} \\sigma_i^2}$$
:::

### 谱范数下界证明（维数交集法）
设任意矩阵 $B$ 满足 $\\operatorname{rank}(B) \\le k$，则其零空间维数满足 $\\dim \\mathcal{N}(B) = n - \\operatorname{rank}(B) \\ge n - k$。与此同时，张成子空间 $W = \\operatorname{span}\\{v_1, v_2, \\dots, v_{k+1}\\}$ 的维数为 $k + 1$。因为：

$$\\dim \\mathcal{N}(B) + \\dim W \\ge (n - k) + (k + 1) = n + 1 > n$$

故交空间 $\\mathcal{N}(B) \\cap W$ 必包含至少一个单位非零向量 $w = \\sum_{i=1}^{k+1} c_i v_i$（其中 $\\|w\\|_2^2 = \\sum_{i=1}^{k+1} c_i^2 = 1$ 且 $Bw = 0$）。于是：

$$\\|A - B\\|_2^2 \\ge \\|(A - B)w\\|_2^2 = \\|Aw\\|_2^2 = \\left\\| \\sum_{i=1}^{k+1} c_i \\sigma_i u_i \\right\\|_2^2 = \\sum_{i=1}^{k+1} c_i^2 \\sigma_i^2 \\ge \\sigma_{k+1}^2 \\sum_{i=1}^{k+1} c_i^2 = \\sigma_{k+1}^2$$

两边开方即证 $\\|A - B\\|_2 \\ge \\sigma_{k+1}$，而直接代入 $B = A_k$ 恰好取得等号。`;

const SEED_WORKBOOK_MARKDOWN = `# 第一部分 基础巩固与概念辨析题组

### 题 1.1 · 难度：基础 · 考点：Beta-Binomial 共轭先验后验推导

设某精密芯片产线的良品率 $\\theta \\in (0,1)$ 为未知随机变量。质检工程师根据历史经验赋予其共轭先验分布 $\\theta \\sim \\operatorname{Beta}(\\alpha, \\beta)$，其概率密度函数为：

$$p(\\theta) = \\frac{\\Gamma(\\alpha + \\beta)}{\\Gamma(\\alpha)\\Gamma(\\beta)} \\theta^{\\alpha - 1} (1 - \\theta)^{\\beta - 1}$$

现独立随机抽检 $n$ 枚芯片，观测到其中有 $k$ 枚合格品。
1. 求参数 $\\theta$ 的后验分布 $p(\\theta \\mid k)$ 的精确形式；
2. 分别写出平方误差损失下的贝叶斯后验均值估计 $\\hat{\\theta}_{\\text{Bayes}}$ 与最大后验概率估计 $\\hat{\\theta}_{\\text{MAP}}$（假定 $\\alpha + k > 1$ 且 $\\beta + n - k > 1$），并解释后验均值如何体现先验均值与最大似然估计的凸组合。

> **分步解析与评分标准**
> 1. **似然函数构造（3分）**：在给定 $\\theta$ 下，合格品数 $K \\mid \\theta \\sim \\operatorname{Binomial}(n, \\theta)$，似然函数为 $L(k \\mid \\theta) = \\binom{n}{k} \\theta^k (1-\\theta)^{n-k}$。
> 2. **后验核匹配（4分）**：由贝叶斯公式，略去与 $\\theta$ 无关的归一化常数，后验密度核为：
>    $$p(\\theta \\mid k) \\propto L(k \\mid \\theta) p(\\theta) \\propto \\theta^{\\alpha + k - 1} (1 - \\theta)^{\\beta + n - k - 1}$$
>    对照 Beta 分布核可知，后验分布严格服从 $\\theta \\mid k \\sim \\operatorname{Beta}(\\alpha + k, \\beta + n - k)$。
> 3. **估计量求解与凸组合阐释（5分）**：
>    利用 Beta 分布期望公式得后验均值估计：
>    $$\\hat{\\theta}_{\\text{Bayes}} = \\mathbb{E}[\\theta \\mid k] = \\frac{\\alpha + k}{\\alpha + \\beta + n} = \\frac{\\alpha + \\beta}{\\alpha + \\beta + n} \\cdot \\frac{\\alpha}{\\alpha + \\beta} + \\frac{n}{\\alpha + \\beta + n} \\cdot \\frac{k}{n}$$
>    可见 $\\hat{\\theta}_{\\text{Bayes}}$ 是先验均值 $\\frac{\\alpha}{\\alpha+\\beta}$ 与最大似然估计 $\\hat{\\theta}_{\\text{MLE}} = \\frac{k}{n}$ 的加权平均；当样本量 $n \\to \\infty$ 时，数据权重趋于 $1$。对对数后验求导令其为零可得：
>    $$\\hat{\\theta}_{\\text{MAP}} = \\frac{\\alpha + k - 1}{\\alpha + \\beta + n - 2}$$

# 第二部分 综合进阶与马尔可夫链收敛性证明

### 题 2.1 · 难度：压轴 · 考点：离散时间马尔可夫链细致平衡方程与平稳分布

设状态空间为 $S = \\{1, 2, 3\\}$ 的齐次马尔可夫链，其一步转移概率矩阵 $P$ 定义如下：

$$P = \\begin{pmatrix} 1/2 & 1/3 & 1/6 \\\\ 1/4 & 1/2 & 1/4 \\\\ 1/8 & 3/8 & 1/2 \\end{pmatrix}$$

1. 判断该马尔可夫链是否不可约（Irreducible）且非周期（Aperiodic），并说明极限分布的存在唯一性；
2. 求解该链的唯一平稳分布行向量 $\\pi = (\\pi_1, \\pi_2, \\pi_3)$，并检验该链是否满足时间可逆性（细致平衡条件 $\\pi_i P_{ij} = \\pi_j P_{ji}$）；
3. 计算从状态 $1$ 出发首次返回状态 $1$ 的期望回访时间 $\\mathbb{E}_1[T_1]$。

> **分步解析与评分标准**
> 1. **遍历性判定（3分）**：矩阵 $P$ 所有元素严格大于 $0$（$P_{ij} > 0, \\forall i,j \\in S$），故所有状态互通，链是不可约的；又因自环概率 $P_{ii} = 1/2 > 0$，各状态周期均为 $\\gcd\\{1, 2, \\dots\\} = 1$，故为有限状态不可约非周期（遍历）马尔可夫链，存在唯一平稳分布且 $\\lim_{n\\to\\infty} P^n_{ij} = \\pi_j$。
> 2. **细致平衡检验与快速求解（6分）**：观察非对角转移比值：若存在可逆测度，则需满足：
>    $$\\frac{\\pi_2}{\\pi_1} = \\frac{P_{12}}{P_{21}} = \\frac{1/3}{1/4} = \\frac{4}{3}, \\quad \\frac{\\pi_3}{\\pi_1} = \\frac{P_{13}}{P_{31}} = \\frac{1/6}{1/8} = \\frac{4}{3}$$
>    继续交叉验证状态 $(2,3)$ 之间的细致平衡：
>    $$\\pi_2 P_{23} = \\left(\\frac{4}{3}\\pi_1\\right) \\cdot \\frac{1}{4} = \\frac{1}{3}\\pi_1, \\quad \\pi_3 P_{32} = \\left(\\frac{4}{3}\\pi_1\\right) \\cdot \\frac{3}{8} = \\frac{1}{2}\\pi_1 \\neq \\pi_2 P_{23}$$
>    **关键结论**：该链**不满足**细致平衡条件（非时间可逆链）！因此必须直接联立线性方程组 $\\pi P = \\pi$ 与 $\\pi_1 + \\pi_2 + \\pi_3 = 1$：
>    $$\\begin{cases} \\frac{1}{2}\\pi_1 + \\frac{1}{4}\\pi_2 + \\frac{1}{8}\\pi_3 = \\pi_1 \\\\ \\frac{1}{3}\\pi_1 + \\frac{1}{2}\\pi_2 + \\frac{3}{8}\\pi_3 = \\pi_2 \\\\ \\pi_1 + \\pi_2 + \\pi_3 = 1 \\end{cases}$$
>    由第一式得 $4\\pi_1 = 2\\pi_2 + \\pi_3 \\Rightarrow \\pi_3 = 4\\pi_1 - 2\\pi_2$。代入第二式：
>    $$\\frac{1}{3}\\pi_1 + \\frac{3}{8}(4\\pi_1 - 2\\pi_2) = \\frac{1}{2}\\pi_2 \\implies \\frac{11}{6}\\pi_1 = \\frac{5}{4}\\pi_2 \\implies \\pi_2 = \\frac{22}{15}\\pi_1$$
>    进而 $\\pi_3 = 4\\pi_1 - \\frac{44}{15}\\pi_1 = \\frac{16}{15}\\pi_1$。归一化求和：$\\pi_1 \\left(1 + \\frac{22}{15} + \\frac{16}{15}\\right) = \\frac{53}{15}\\pi_1 = 1$，解得唯一平稳分布为：
>    $$\\pi = \\left(\\frac{15}{53}, \\frac{22}{53}, \\frac{16}{53}\\right)$$
> 3. **期望回访时间（3分）**：由遍历马尔可夫链 Kac 定理，状态 $1$ 的平均回访时间等于其平稳概率的倒数：
>    $$\\mathbb{E}_1[T_1] = \\frac{1}{\\pi_1} = \\frac{53}{15} \\approx 3.5333$$`;

export function createInitialSeedJobs(): PipelineJob[] {
  const svdMetrics = countAcademicMetrics(SEED_SVD_MARKDOWN);
  const wbMetrics = countAcademicMetrics(SEED_WORKBOOK_MARKDOWN);

  return [
    {
      id: 'seed-svd-lecture-01',
      createdAt: '2026-11-15T18:20:00.000Z',
      updatedAt: '2026-11-15T18:24:12.000Z',
      mode: 'lecture_notes',
      depth: 'comprehensive',
      colorTheme: 'academic_blue',
      autoGenerateFigures: true,
      isStitchedAndPolished: true,
      multiModelTokenCostSavingsPct: 34,
      modelUsageBreakdown: [
        {
          modelId: 'gemini-4-carbon',
          codeName: 'Carbon',
          calls: 2,
          inputTokens: 4820,
          outputTokens: 3460,
          roleSummary: '总纲路由编排 + 第二章 Eckart-Young-Mirsky 压轴定理严密证明',
        },
        {
          modelId: 'gemini-4-hydrogen',
          codeName: 'Hydrogen',
          calls: 1,
          inputTokens: 3150,
          outputTokens: 4680,
          roleSummary: '第一章概念动机精讲、彩色定义/警示框填色排版与复杂度对照表',
        },
      ],
      rawUserPrompt: '写一份关于矩阵奇异值分解 SVD 与 Eckart-Young 低秩近似定理的课程讲义。',
      customRootFolder: 'Carbon 学术归档',
      autoArchiveDrive: true,
      attachmentsMeta: [
        {
          id: 'att-demo-1',
          name: 'Week07_Matrix_Analysis_Syllabus.pdf',
          mimeType: 'application/pdf',
          size: 418200,
          kind: 'pdf',
        },
      ],
      stage: 'completed',
      plan: {
        documentTitle: '矩阵奇异值分解 (SVD) 与最优低秩近似理论讲义',
        subtitle: '从格拉姆矩阵谱分解、几何诱导范数到 Eckart-Young-Mirsky 定理严密证明',
        subjectCategory: '高等线性代数',
        courseCode: 'MATH-304',
        archiveRootFolder: 'Carbon 学术归档',
        archiveSubjectFolder: '高等线性代数',
        suggestedFileName: 'MATH304_SVD与低秩近似深度讲义.pdf',
        colorTheme: 'academic_blue',
        autoGenerateFigures: true,
        singleCallTargetWords: 4800,
        adaptiveStrategyNote:
          '采用质量优先适度单次容量（~4,800 字/模块），分 2 个高精模块独立编纂后无缝拼接合卷',
        orchestrationSummary:
          '主思考模型 Carbon 按板块特性分配模型：第 1 模块调度 Hydrogen 负责概念直觉、皇家蓝定义框与多维复杂度表格填色排版；第 2 模块由 Carbon 亲自执笔 Eckart-Young-Mirsky 定理维数交集法严密证明，综合节省约 34% Token 成本。',
        expandedPrompt:
          '将用户关于奇异值分解的简短请求系统扩写为两章研究生先修级讲义：第一章从对称矩阵谱定理出发自然引出任意矩阵 SVD 的代数构造，给出基于格拉姆矩阵特征向量的完整存在性证明，并对比完全/紧凑/截断三种分解形态的计算复杂度；第二章聚焦低秩矩阵近似，给出 Eckart-Young-Mirsky 定理在算子范数下的维数交集法完整证明及工程降维意义。',
        pedagogicalGoals: [
          '掌握任意实矩阵奇异值分解的存在性构造证明及左右奇异向量的正交子空间意义',
          '区分完全 SVD、紧凑 SVD 与截断 SVD 的时间复杂度及数值计算场景',
          '理解并独立推导 Eckart-Young-Mirsky 最优低秩近似误差界定理',
        ],
        batches: [
          {
            batchIndex: 1,
            title: '第一模块：SVD 概念动机、彩色定义框排版与三种分解复杂度对比',
            scopeSummary: '完整推导格拉姆矩阵正交特征基、奇异向量正交性验证及彩色知识框/对照表排版',
            sections: ['1.1 从特征值分解到任意矩阵正交对角化', '1.2 存在性严密证明与分解形态对比'],
            estimatedPages: 4,
            targetWords: 4600,
            includeAnswerKey: false,
            assignedModelId: 'gemini-4-hydrogen',
            specialistRole: 'conceptual_prose_and_color_layout',
            dispatchReason:
              'Carbon 调度 Hydrogen 高吞吐排版模型：负责概念导引、彩色定义/警示框填色排版与复杂度表（节省 72% Token 成本）',
          },
          {
            batchIndex: 2,
            title: '第二模块：Eckart-Young-Mirsky 低秩逼近定理与维数交集法严密证明',
            scopeSummary: '完整呈现最优秩-k 逼近定理在谱范数与 Frobenius 范数下的表述及无跳步推导',
            sections: ['2.1 最优秩-k 逼近定理与误差精确刻画', '2.2 谱范数下界维数交集法证明'],
            estimatedPages: 4,
            targetWords: 4800,
            includeAnswerKey: false,
            assignedModelId: 'gemini-4-carbon',
            specialistRole: 'orchestration_and_proof',
            dispatchReason:
              'Carbon 主模型自留压轴证明模块：确保维数交集法与算子范数下界推导 100% 严密闭合',
          },
        ],
      },
      batches: [
        {
          batchIndex: 1,
          title: '第一模块：SVD 概念动机、彩色定义框排版与三种分解复杂度对比',
          modelUsed: 'gemini-4-hydrogen',
          status: 'completed',
          continuationCount: 0,
          markdownContent: SEED_SVD_MARKDOWN.split('# 第二章')[0].trim(),
        },
        {
          batchIndex: 2,
          title: '第二模块：Eckart-Young-Mirsky 低秩逼近定理与维数交集法严密证明',
          modelUsed: 'gemini-4-carbon',
          status: 'completed',
          continuationCount: 0,
          markdownContent: '# 第二章' + SEED_SVD_MARKDOWN.split('# 第二章')[1],
        },
      ],
      compiledMarkdown: SEED_SVD_MARKDOWN,
      charCount: svdMetrics.charCount,
      formulaCount: svdMetrics.formulaCount,
      estimatedPages: svdMetrics.estimatedPages,
      driveArchive: {
        status: 'pending_auth',
        folderPath: 'Carbon 学术归档 / 高等线性代数 / 课程讲义 (Lecture Notes)',
      },
    },
    {
      id: 'seed-bayes-workbook-02',
      createdAt: '2026-11-16T02:10:00.000Z',
      updatedAt: '2026-11-16T02:15:30.000Z',
      mode: 'workbook',
      depth: 'comprehensive',
      volumeSplitMode: 'auto',
      colorTheme: 'amber_olympiad',
      autoGenerateFigures: true,
      isStitchedAndPolished: true,
      multiModelTokenCostSavingsPct: 33,
      modelUsageBreakdown: [
        {
          modelId: 'gemini-4-carbon',
          codeName: 'Carbon',
          calls: 1,
          inputTokens: 2180,
          outputTokens: 1240,
          roleSummary: '双分册结构规划与专精模型路由调度',
        },
        {
          modelId: 'gemini-4-argon',
          codeName: 'Argon',
          calls: 2,
          inputTokens: 6420,
          outputTokens: 8960,
          roleSummary: '正题题本分级命题 + 第 2 分册逐题分步演算与采分标准撰写',
        },
      ],
      rawUserPrompt:
        '出一套贝叶斯共轭先验与离散马尔可夫链平稳分布的精编练习题册，正题题本与详细评分标准答案另外一份独立文件输出。',
      customRootFolder: 'Carbon 学术归档',
      autoArchiveDrive: true,
      attachmentsMeta: [],
      consolidatedRequirements: {
        version: 2,
        lastConsolidatedAt: '2026-11-16T02:11:00.000Z',
        synthesizedMasterBrief:
          '- 【核心范围与章节目标】：共轭先验 Beta-Binomial 后验推断与非时间可逆有限马尔可夫链平稳分布及 Kac 回访时间\n- 【分册与多文件独立输出规则】：正题题本（学生自测卷）与完整分步解答及评分标准拆分为 2 份独立 PDF 文件输出\n- 【例题/习题梯度与解析要求】：每道大题配备按步骤采分标准，严禁跳步',
        activeRules: [
          {
            id: 'req-1',
            category: 'scope',
            summary: '覆盖 Beta-Binomial 共轭先验推断与离散马尔可夫链平稳分布及期望回访时间',
            sourceLabel: '初始需求',
            status: 'active',
          },
          {
            id: 'req-2',
            category: 'volume_split',
            summary: '正题题本与答案解析另外一份独立文件输出（共 2 份独立 PDF）',
            sourceLabel: '分册识别引擎',
            status: 'active',
          },
        ],
        changeLog: [
          '[分册识别引擎] 自动识别“正题与答案解析另外一份独立文件”：拆分为《第 1 分册：题本》与《第 2 分册：详解册》',
        ],
        rawAccumulatedChars: 420,
        compressedContextChars: 215,
        tokenSavingsEstimatePct: 49,
      },
      stage: 'completed',
      plan: {
        documentTitle: '贝叶斯统计推断与离散马尔可夫链精编练习题册',
        subtitle: '含共轭先验后验凸组合分析、细致平衡可逆性判别与 Kac 回访定理详解',
        subjectCategory: '概率论与数理统计',
        courseCode: 'STAT-312',
        archiveRootFolder: 'Carbon 学术归档',
        archiveSubjectFolder: '概率论与数理统计',
        suggestedFileName: 'STAT312_贝叶斯与马尔可夫链练习题册.pdf',
        colorTheme: 'amber_olympiad',
        autoGenerateFigures: true,
        expandedPrompt:
          '将用户需求扩展为正题与解析独立成册的专业练习题集：第 1 分册为无剧透学生自测题本，涵盖 Beta-Binomial 共轭家族与非时间可逆马尔可夫链综合压轴题；第 2 分册为独立详解与评分标准册，逐题给出核匹配、细致平衡反例判别、线性方程组求解与 Kac 回访定理采分点。',
        pedagogicalGoals: [
          '熟练推导共轭先验下的后验分布参数更新规则及 MAP / 后验均值估计',
          '掌握有限状态马尔可夫链不可约性、非周期性与遍历性判定准则',
          '准确识别非可逆马尔可夫链中的细致平衡陷阱并熟练求解平稳分布方程组',
        ],
        isMultiVolume: true,
        singleCallTargetWords: 4800,
        adaptiveStrategyNote:
          '采用质量优先适度单次容量（~4,800 字/模块），拆分为 2 份独立 PDF 分册（题本卷 + 独立答案解析册）',
        orchestrationSummary:
          'Carbon 主模型完成双分册结构规划后，按需调度数理命题与演算专精模型 Argon 分别完成第 1 分册梯度题本与第 2 分册逐题采分详解，提升推导精度并降低 33% Token 消耗。',
        volumes: [
          {
            volumeId: 'vol-1',
            volumeIndex: 1,
            volumeTitle: '贝叶斯与马尔可夫链精编题册 · 第 1 分册：学生自测题本',
            subtitle: '纯净题干分册（不含答案剧透，适合课堂限时训练与模考）',
            suggestedFileName: 'STAT312_第1分册_学生自测题本.pdf',
            role: 'workbook',
            scopeSummary: '收录基础巩固与综合压轴全部完整题干与数学条件设定',
          },
          {
            volumeId: 'vol-2',
            volumeIndex: 2,
            volumeTitle: '贝叶斯与马尔可夫链精编题册 · 第 2 分册：答案与评分标准详解册',
            subtitle: '逐题严密分步推导与采分点专册（独立 PDF 文件）',
            suggestedFileName: 'STAT312_第2分册_答案与评分详解册.pdf',
            role: 'solutions_manual',
            scopeSummary: '严格对应第 1 分册题号，提供完整分步推导、细致平衡陷阱剖析与分值标准',
          },
        ],
        batches: [
          {
            batchIndex: 1,
            title: '第 1 分册精编模块：全册分级精选题干（基础共轭先验 + 压轴马尔可夫链）',
            scopeSummary: '完整输出学生卷全部题干与小问设问（不含答案解析）',
            sections: ['第一部分 基础巩固：Beta-Binomial 共轭推断题干', '第二部分 综合压轴：马尔可夫链平稳分布题干'],
            estimatedPages: 3,
            targetWords: 4500,
            includeAnswerKey: false,
            volumeId: 'vol-1',
            volumeIndex: 1,
            assignedModelId: 'gemini-4-argon',
            specialistRole: 'stem_problem_derivation',
            dispatchReason:
              'Carbon 调度 Argon 数理命题专精模型：设计严谨边界条件与多梯度概率统计题干',
          },
          {
            batchIndex: 2,
            title: '第 2 分册精编模块：全册逐题分步解析与评分标准专册',
            scopeSummary: '严格对齐第 1 分册题号，独立输出全部详细推导与按步给分标准',
            sections: ['题 1.1 分步解析与评分细则', '题 2.1 细致平衡判别与平稳分布完整求解'],
            estimatedPages: 4,
            targetWords: 4800,
            includeAnswerKey: true,
            volumeId: 'vol-2',
            volumeIndex: 2,
            assignedModelId: 'gemini-4-argon',
            specialistRole: 'stem_problem_derivation',
            dispatchReason:
              'Carbon 调度 Argon 数理演算专精模型：逐题输出无跳步代数推导、细致平衡反例检验与采分点',
          },
        ],
      },
      batches: [
        {
          batchIndex: 1,
          title: '第 1 分册精编模块：全册分级精选题干（基础共轭先验 + 压轴马尔可夫链）',
          volumeId: 'vol-1',
          volumeIndex: 1,
          modelUsed: 'gemini-4-argon',
          status: 'completed',
          continuationCount: 0,
          markdownContent: SEED_WORKBOOK_MARKDOWN.replace(/> \*\*分步解析与评分标准\*\*[\s\S]*?(?=\n# |\n*$)/g, '').trim(),
        },
        {
          batchIndex: 2,
          title: '第 2 分册精编模块：全册逐题分步解析与评分标准专册',
          volumeId: 'vol-2',
          volumeIndex: 2,
          modelUsed: 'gemini-4-argon',
          status: 'completed',
          continuationCount: 0,
          markdownContent: `# 第 1 部分 基础巩固题组详解与评分标准\n\n### 题 1.1 标准解答\n\n${
            SEED_WORKBOOK_MARKDOWN.match(/> \*\*分步解析与评分标准\*\*[\s\S]*?(?=\n# 第二部分)/)?.[0] || ''
          }\n\n# 第 2 部分 综合压轴题组详解与评分标准\n\n### 题 2.1 标准解答\n\n${
            SEED_WORKBOOK_MARKDOWN.split('3. 计算从状态 $1$ 出发首次返回状态 $1$ 的期望回访时间 $\\mathbb{E}_1[T_1]$。')[1]?.trim() || ''
          }`,
        },
      ],
      outputVolumes: [
        {
          volumeId: 'vol-1',
          volumeIndex: 1,
          volumeTitle: '贝叶斯与马尔可夫链精编题册 · 第 1 分册：学生自测题本',
          subtitle: '纯净题干分册（不含答案剧透，适合课堂限时训练与模考）',
          fileName: 'STAT312_第1分册_学生自测题本.pdf',
          role: 'workbook',
          status: 'completed',
          compiledMarkdown: SEED_WORKBOOK_MARKDOWN.replace(
            /> \*\*分步解析与评分标准\*\*[\s\S]*?(?=\n# |\n*$)/g,
            ''
          ).trim(),
          charCount: Math.round(wbMetrics.charCount * 0.42),
          formulaCount: Math.round(wbMetrics.formulaCount * 0.4),
          estimatedPages: 1,
          serverPdfReady: false,
        },
        {
          volumeId: 'vol-2',
          volumeIndex: 2,
          volumeTitle: '贝叶斯与马尔可夫链精编题册 · 第 2 分册：答案与评分标准详解册',
          subtitle: '逐题严密分步推导与采分点专册（独立 PDF 文件）',
          fileName: 'STAT312_第2分册_答案与评分详解册.pdf',
          role: 'solutions_manual',
          status: 'completed',
          compiledMarkdown: `# 第 1 部分 基础巩固题组详解与评分标准\n\n### 题 1.1 标准解答\n\n${
            SEED_WORKBOOK_MARKDOWN.match(/> \*\*分步解析与评分标准\*\*[\s\S]*?(?=\n# 第二部分)/)?.[0] || ''
          }\n\n# 第 2 部分 综合压轴题组详解与评分标准\n\n### 题 2.1 标准解答\n\n${
            SEED_WORKBOOK_MARKDOWN.split(
              '3. 计算从状态 $1$ 出发首次返回状态 $1$ 的期望回访时间 $\\mathbb{E}_1[T_1]$。'
            )[1]?.trim() || ''
          }`,
          charCount: Math.round(wbMetrics.charCount * 0.58),
          formulaCount: Math.round(wbMetrics.formulaCount * 0.6),
          estimatedPages: 2,
          serverPdfReady: false,
        },
      ],
      compiledMarkdown: SEED_WORKBOOK_MARKDOWN,
      charCount: wbMetrics.charCount,
      formulaCount: wbMetrics.formulaCount,
      estimatedPages: wbMetrics.estimatedPages,
      driveArchive: {
        status: 'pending_auth',
        folderPath: 'Carbon 学术归档 / 概率论与数理统计 / 练习题册 (Workbooks)',
      },
    },
  ];
}
