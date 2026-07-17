/**
 * @owner       src::commands::ai-landscape
 * @does        Defines the maintained AI primary-source directory and practitioner-role profiles used for precise official-domain selection, source attribution, discovery, and current-information pulses.
 * @needs       Stable first-party domains/repositories and registry source refs verified by live probes or upstream source.
 * @feeds       src/commands/ai.ts, src/commands/ai-content.ts, and ai.landscape/pulse/search outputs.
 * @breaks      Stale domains, generic GitHub-domain attribution, or role profiles without bounded source/query scopes make primary evidence noisy or falsely official.
 * @invariants  Catalog entries represent maintainer-owned surfaces; generic community hosts are never treated as official without a matching repository; explicit site: scopes always outrank inferred domains.
 * @side-effects None.
 * @perf        O(S * (D + R + K)) over a bounded static catalog.
 * @concurrency safe
 * @test        tests/unit/commands/ai.test.ts and tests/unit/adapters/ai-intelligence.test.ts
 * @stability   experimental
 * @since       2026-07-17
 */

export type AiRoleProfileId =
  | "all"
  | "foundation-models"
  | "llm-training"
  | "inference"
  | "world-models"
  | "embodied-ai"
  | "hardware"
  | "agents"
  | "evaluation-safety"
  | "research";

export type AiOrganizationType =
  | "lab"
  | "hardware"
  | "cloud"
  | "runtime"
  | "model-hub"
  | "research"
  | "benchmark"
  | "robotics"
  | "community";

export interface AiPrimarySource {
  id: string;
  name: string;
  type: AiOrganizationType;
  roles: AiRoleProfileId[];
  domains: string[];
  repositories: string[];
  topics: string[];
  channels: string[];
}

export interface AiRoleProfile {
  id: AiRoleProfileId;
  name: string;
  description: string;
  pulseQueries: string[];
  keywords: string[];
  sourceRefs: string[];
}

function source(
  id: string,
  name: string,
  type: AiOrganizationType,
  roles: AiRoleProfileId[],
  details: Omit<AiPrimarySource, "id" | "name" | "type" | "roles">,
): AiPrimarySource {
  return { id, name, type, roles, ...details };
}

export const AI_PRIMARY_SOURCES: readonly AiPrimarySource[] = [
  source(
    "openai",
    "OpenAI",
    "lab",
    ["foundation-models", "agents", "evaluation-safety"],
    {
      domains: ["openai.com", "platform.openai.com"],
      repositories: [
        "openai/openai-python",
        "openai/openai-node",
        "openai/evals",
      ],
      topics: ["openai", "gpt", "reasoning model", "responses api", "codex"],
      channels: [
        "research",
        "news",
        "api-docs",
        "model-system-cards",
        "github-releases",
      ],
    },
  ),
  source(
    "anthropic",
    "Anthropic",
    "lab",
    ["foundation-models", "agents", "evaluation-safety"],
    {
      domains: ["anthropic.com", "docs.anthropic.com"],
      repositories: [
        "anthropics/anthropic-sdk-python",
        "anthropics/anthropic-sdk-typescript",
        "anthropics/courses",
      ],
      topics: [
        "anthropic",
        "claude",
        "constitutional ai",
        "model context protocol",
        "mcp",
      ],
      channels: [
        "research",
        "news",
        "api-docs",
        "system-cards",
        "github-releases",
      ],
    },
  ),
  source(
    "google-deepmind",
    "Google DeepMind",
    "lab",
    ["foundation-models", "world-models", "embodied-ai", "research"],
    {
      domains: ["deepmind.google", "research.google"],
      repositories: [
        "google-deepmind/gemma",
        "google-deepmind/dm_control",
        "google-deepmind/open_x_embodiment",
      ],
      topics: [
        "deepmind",
        "gemini",
        "gemma",
        "genie",
        "world model",
        "alphafold",
        "robotics",
      ],
      channels: ["research", "blog", "papers", "datasets", "github-releases"],
    },
  ),
  source(
    "google-gemini",
    "Google Gemini",
    "lab",
    ["foundation-models", "agents"],
    {
      domains: ["ai.google.dev", "developers.googleblog.com"],
      repositories: [
        "googleapis/python-genai",
        "googleapis/js-genai",
        "google-gemini/gemma-cookbook",
      ],
      topics: ["gemini", "gemma", "google genai", "vertex ai"],
      channels: ["api-docs", "release-notes", "cookbooks", "github-releases"],
    },
  ),
  source(
    "meta-ai",
    "Meta AI / FAIR",
    "lab",
    ["foundation-models", "world-models", "embodied-ai", "research"],
    {
      domains: ["ai.meta.com"],
      repositories: [
        "meta-llama/llama",
        "facebookresearch/vjepa2",
        "facebookresearch/habitat-lab",
        "facebookresearch/xformers",
      ],
      topics: [
        "meta ai",
        "fair",
        "llama",
        "v-jepa",
        "vjepa",
        "habitat",
        "segment anything",
      ],
      channels: [
        "research",
        "blog",
        "model-cards",
        "datasets",
        "github-releases",
      ],
    },
  ),
  source(
    "microsoft-ai",
    "Microsoft AI and Research",
    "lab",
    ["foundation-models", "agents", "research"],
    {
      domains: ["microsoft.com", "azure.microsoft.com", "learn.microsoft.com"],
      repositories: ["microsoft/semantic-kernel", "microsoft/autogen"],
      topics: [
        "microsoft ai",
        "azure ai",
        "phi",
        "deepspeed",
        "onnx runtime",
        "semantic kernel",
        "autogen",
      ],
      channels: ["research", "azure-docs", "release-notes", "github-releases"],
    },
  ),
  source("xai", "xAI", "lab", ["foundation-models", "agents"], {
    domains: ["x.ai", "docs.x.ai"],
    repositories: ["xai-org/grok-1", "xai-org/xai-sdk-python"],
    topics: ["xai", "grok"],
    channels: ["news", "api-docs", "model-cards", "github-releases"],
  }),
  source("mistral", "Mistral AI", "lab", ["foundation-models", "agents"], {
    domains: ["mistral.ai", "docs.mistral.ai"],
    repositories: [
      "mistralai/mistral-inference",
      "mistralai/client-python",
      "mistralai/client-ts",
    ],
    topics: ["mistral", "mixtral", "ministral", "codestral"],
    channels: [
      "news",
      "research",
      "api-docs",
      "model-cards",
      "github-releases",
    ],
  }),
  source("cohere", "Cohere", "lab", ["foundation-models", "agents"], {
    domains: ["cohere.com", "docs.cohere.com"],
    repositories: [
      "cohere-ai/cohere-python",
      "cohere-ai/cohere-typescript",
      "cohere-ai/cohere-toolkit",
    ],
    topics: ["cohere", "command r", "embed", "rerank"],
    channels: ["research", "blog", "api-docs", "github-releases"],
  }),
  source(
    "ai2",
    "Allen Institute for AI",
    "lab",
    ["foundation-models", "research", "evaluation-safety"],
    {
      domains: ["allenai.org"],
      repositories: [
        "allenai/OLMo",
        "allenai/open-instruct",
        "allenai/ai2-arc",
      ],
      topics: ["allenai", "ai2", "olmo", "open instruct", "dolma"],
      channels: ["research", "blog", "models", "datasets", "github-releases"],
    },
  ),
  source(
    "deepseek",
    "DeepSeek",
    "lab",
    ["foundation-models", "llm-training", "inference"],
    {
      domains: ["deepseek.com", "api-docs.deepseek.com"],
      repositories: [
        "deepseek-ai/DeepSeek-V3",
        "deepseek-ai/DeepSeek-R1",
        "deepseek-ai/DeepSeek-Coder-V2",
      ],
      topics: ["deepseek", "deepseek r1", "deepseek v3", "deepseek coder"],
      channels: [
        "api-docs",
        "model-cards",
        "technical-reports",
        "github-releases",
      ],
    },
  ),
  source(
    "qwen",
    "Qwen",
    "lab",
    ["foundation-models", "llm-training", "agents"],
    {
      domains: ["qwenlm.github.io"],
      repositories: [
        "QwenLM/Qwen3",
        "QwenLM/Qwen-Agent",
        "QwenLM/Qwen3-VL",
        "QwenLM/Qwen3-Coder",
      ],
      topics: ["qwen", "tongyi", "通义千问", "wan video"],
      channels: ["blog", "model-cards", "cookbooks", "github-releases"],
    },
  ),
  source("zhipu", "Zhipu AI / GLM", "lab", ["foundation-models", "agents"], {
    domains: ["bigmodel.cn", "zhipuai.cn"],
    repositories: ["THUDM/GLM-4", "THUDM/ChatGLM3", "THUDM/CogVideo"],
    topics: ["zhipu", "智谱", "chatglm", "glm", "cogvideo"],
    channels: [
      "api-docs",
      "model-cards",
      "technical-reports",
      "github-releases",
    ],
  }),
  source("moonshot", "Moonshot AI", "lab", ["foundation-models", "agents"], {
    domains: ["moonshot.ai", "platform.moonshot.cn"],
    repositories: ["MoonshotAI/Kimi-K2", "MoonshotAI/Moonlight"],
    topics: ["moonshot ai", "kimi", "moonlight"],
    channels: [
      "api-docs",
      "model-cards",
      "technical-reports",
      "github-releases",
    ],
  }),
  source(
    "minimax",
    "MiniMax",
    "lab",
    ["foundation-models", "world-models", "agents"],
    {
      domains: ["minimax.io", "platform.minimax.io"],
      repositories: ["MiniMax-AI/MiniMax-Text-01", "MiniMax-AI/MiniMax-M1"],
      topics: ["minimax", "hailuo", "abab"],
      channels: ["api-docs", "model-cards", "video-models", "github-releases"],
    },
  ),
  source(
    "tencent-hunyuan",
    "Tencent Hunyuan",
    "lab",
    ["foundation-models", "world-models"],
    {
      domains: ["hunyuan.tencent.com", "cloud.tencent.com"],
      repositories: [
        "Tencent-Hunyuan/Hunyuan-A13B",
        "Tencent-Hunyuan/HunyuanVideo",
        "Tencent-Hunyuan/Hunyuan3D-2",
      ],
      topics: ["hunyuan", "混元", "hunyuan video", "hunyuan3d"],
      channels: [
        "model-cards",
        "cloud-docs",
        "technical-reports",
        "github-releases",
      ],
    },
  ),
  source(
    "bytedance-seed",
    "ByteDance Seed",
    "lab",
    ["foundation-models", "world-models", "agents"],
    {
      domains: ["seed.bytedance.com", "volcengine.com"],
      repositories: [
        "bytedance/Seed1.5-VL",
        "bytedance/verl",
        "bytedance/trae-agent",
      ],
      topics: [
        "bytedance seed",
        "seedance",
        "seedream",
        "doubao",
        "豆包",
        "verl",
      ],
      channels: ["research", "model-cards", "cloud-docs", "github-releases"],
    },
  ),
  source(
    "paddle",
    "Baidu PaddlePaddle",
    "runtime",
    ["foundation-models", "llm-training", "inference"],
    {
      domains: ["paddlepaddle.org.cn", "ai.baidu.com"],
      repositories: [
        "PaddlePaddle/Paddle",
        "PaddlePaddle/PaddleNLP",
        "PaddlePaddle/FastDeploy",
      ],
      topics: ["paddlepaddle", "paddlenlp", "ernie", "文心", "fastdeploy"],
      channels: [
        "framework-docs",
        "model-hub",
        "release-notes",
        "github-releases",
      ],
    },
  ),
  source(
    "hugging-face",
    "Hugging Face",
    "model-hub",
    [
      "foundation-models",
      "llm-training",
      "inference",
      "world-models",
      "research",
    ],
    {
      domains: ["huggingface.co"],
      repositories: [
        "huggingface/transformers",
        "huggingface/trl",
        "huggingface/accelerate",
        "huggingface/text-generation-inference",
        "huggingface/lerobot",
      ],
      topics: [
        "hugging face",
        "transformers",
        "trl",
        "accelerate",
        "model hub",
        "dataset hub",
        "lerobot",
      ],
      channels: [
        "models",
        "datasets",
        "spaces",
        "papers",
        "forum",
        "docs",
        "github-releases",
      ],
    },
  ),
  source(
    "modelscope",
    "ModelScope",
    "model-hub",
    ["foundation-models", "world-models", "research"],
    {
      domains: ["modelscope.cn", "modelscope.ai"],
      repositories: [
        "modelscope/modelscope",
        "modelscope/modelscope_hub",
        "modelscope/ms-swift",
      ],
      topics: ["modelscope", "魔搭", "ms-swift"],
      channels: ["models", "datasets", "studios", "openapi", "github-releases"],
    },
  ),
  source(
    "opencsg",
    "OpenCSG",
    "model-hub",
    ["foundation-models", "world-models", "research"],
    {
      domains: ["opencsg.com", "hub.opencsg.com"],
      repositories: [
        "OpenCSGs/csghub",
        "OpenCSGs/csghub-server",
        "OpenCSGs/csghub-sdk",
      ],
      topics: ["opencsg", "csghub", "开放传神"],
      channels: ["models", "datasets", "spaces", "api-docs", "github-releases"],
    },
  ),
  source(
    "replicate",
    "Replicate",
    "model-hub",
    ["foundation-models", "world-models", "agents"],
    {
      domains: ["replicate.com", "api.replicate.com"],
      repositories: [
        "replicate/replicate-python",
        "replicate/replicate-javascript",
        "replicate/cog",
      ],
      topics: ["replicate", "cog", "model api"],
      channels: [
        "models",
        "collections",
        "api-docs",
        "blog",
        "github-releases",
      ],
    },
  ),
  source(
    "openrouter",
    "OpenRouter",
    "model-hub",
    ["foundation-models", "agents", "evaluation-safety"],
    {
      domains: ["openrouter.ai"],
      repositories: ["OpenRouterTeam/openrouter-runner"],
      topics: ["openrouter", "model routing", "model pricing"],
      channels: ["model-catalog", "rankings", "api-docs", "status"],
    },
  ),
  source(
    "kaggle",
    "Kaggle",
    "model-hub",
    ["research", "evaluation-safety", "foundation-models"],
    {
      domains: ["kaggle.com"],
      repositories: ["Kaggle/kagglehub", "Kaggle/kaggle-cli"],
      topics: ["kaggle", "competition", "dataset", "benchmark"],
      channels: [
        "datasets",
        "models",
        "competitions",
        "notebooks",
        "discussions",
      ],
    },
  ),
  source(
    "nvidia",
    "NVIDIA AI",
    "hardware",
    ["hardware", "llm-training", "inference", "world-models", "embodied-ai"],
    {
      domains: [
        "docs.nvidia.com",
        "developer.nvidia.com",
        "catalog.ngc.nvidia.com",
        "nvidia.com",
      ],
      repositories: [
        "NVIDIA/TensorRT-LLM",
        "NVIDIA/Megatron-LM",
        "NVIDIA/NeMo",
        "NVIDIA/cutlass",
        "NVIDIA/TransformerEngine",
        "NVIDIA/IsaacLab",
      ],
      topics: [
        "nvidia",
        "cuda",
        "cudnn",
        "nccl",
        "tensorrt",
        "dgx",
        "nim",
        "ngc",
        "cosmos",
        "isaac",
      ],
      channels: [
        "driver-docs",
        "sdk-docs",
        "release-notes",
        "security-bulletins",
        "ngc",
        "github-releases",
      ],
    },
  ),
  source(
    "amd",
    "AMD AI / ROCm",
    "hardware",
    ["hardware", "llm-training", "inference"],
    {
      domains: ["rocm.docs.amd.com", "amd.com"],
      repositories: [
        "ROCm/ROCm",
        "ROCm/hip",
        "ROCm/composable_kernel",
        "ROCm/rocm-libraries",
        "ROCm/rocm-systems",
      ],
      topics: ["amd", "rocm", "hip", "mi300", "mi325", "mi350", "instinct"],
      channels: [
        "driver-docs",
        "sdk-docs",
        "compatibility-matrix",
        "release-notes",
        "github-releases",
      ],
    },
  ),
  source(
    "huawei-ascend",
    "Huawei Ascend",
    "hardware",
    ["hardware", "llm-training", "inference"],
    {
      domains: ["hiascend.com", "huawei.com"],
      repositories: [
        "Ascend/pytorch",
        "Ascend/torch_npu",
        "Ascend/ModelZoo-PyTorch",
        "MindSpore/mindspore",
      ],
      topics: [
        "huawei ascend",
        "昇腾",
        "cann",
        "mindie",
        "mindspore",
        "ascend 910",
      ],
      channels: [
        "hardware-docs",
        "cann-docs",
        "mindie-docs",
        "release-notes",
        "github-releases",
      ],
    },
  ),
  source(
    "intel-ai",
    "Intel AI / Gaudi",
    "hardware",
    ["hardware", "llm-training", "inference"],
    {
      domains: ["docs.habana.ai", "intel.com", "oneapi.io"],
      repositories: [
        "HabanaAI/Model-References",
        "intel/intel-extension-for-pytorch",
        "oneapi-src/oneDNN",
      ],
      topics: ["intel gaudi", "habana", "oneapi", "onednn", "xeon ai"],
      channels: [
        "driver-docs",
        "sdk-docs",
        "model-references",
        "release-notes",
        "github-releases",
      ],
    },
  ),
  source(
    "aws-neuron",
    "AWS Trainium / Inferentia",
    "hardware",
    ["hardware", "llm-training", "inference"],
    {
      domains: [
        "awsdocs-neuron.readthedocs-hosted.com",
        "docs.aws.amazon.com",
        "aws.amazon.com",
      ],
      repositories: [
        "aws-neuron/aws-neuron-sdk",
        "aws-neuron/neuronx-distributed",
        "aws-neuron/neuronx-nemo-megatron",
      ],
      topics: [
        "aws neuron",
        "trainium",
        "inferentia",
        "trn1",
        "trn2",
        "neuronx",
      ],
      channels: [
        "sdk-docs",
        "release-notes",
        "containers",
        "examples",
        "github-releases",
      ],
    },
  ),
  source(
    "google-tpu",
    "Google Cloud TPU",
    "hardware",
    ["hardware", "llm-training", "inference"],
    {
      domains: ["cloud.google.com", "docs.cloud.google.com"],
      repositories: ["tensorflow/tpu", "GoogleCloudPlatform/tpu-recipes"],
      topics: ["cloud tpu", "tpu v5", "tpu v6", "jax tpu", "xla"],
      channels: [
        "hardware-docs",
        "cloud-docs",
        "release-notes",
        "github-releases",
      ],
    },
  ),
  source(
    "cerebras",
    "Cerebras",
    "hardware",
    ["hardware", "llm-training", "inference"],
    {
      domains: ["docs.cerebras.net", "cerebras.ai"],
      repositories: ["Cerebras/modelzoo", "Cerebras/cerebras-cloud-sdk-python"],
      topics: ["cerebras", "wafer scale", "wse", "cs-3"],
      channels: ["hardware-docs", "model-zoo", "cloud-docs", "github-releases"],
    },
  ),
  source("groq", "Groq", "hardware", ["hardware", "inference"], {
    domains: ["console.groq.com", "groq.com"],
    repositories: ["groq/groq-python", "groq/groq-typescript"],
    topics: ["groq", "lpu", "groqcloud"],
    channels: [
      "api-docs",
      "model-catalog",
      "release-notes",
      "status",
      "github-releases",
    ],
  }),
  source(
    "tenstorrent",
    "Tenstorrent",
    "hardware",
    ["hardware", "llm-training", "inference"],
    {
      domains: ["docs.tenstorrent.com", "tenstorrent.com"],
      repositories: [
        "tenstorrent/tt-metal",
        "tenstorrent/tt-forge-fe",
        "tenstorrent/tt-mlir",
      ],
      topics: ["tenstorrent", "tt-metal", "tt-forge", "wormhole", "blackhole"],
      channels: [
        "hardware-docs",
        "sdk-docs",
        "compiler-docs",
        "github-releases",
      ],
    },
  ),
  source(
    "sambanova",
    "SambaNova",
    "hardware",
    ["hardware", "llm-training", "inference"],
    {
      domains: ["docs.sambanova.ai", "sambanova.ai"],
      repositories: ["sambanova/ai-starter-kit"],
      topics: ["sambanova", "rdau", "sambastudio", "sambacloud"],
      channels: ["platform-docs", "model-catalog", "release-notes", "github"],
    },
  ),
  source(
    "apple-mlx",
    "Apple MLX / Metal",
    "hardware",
    ["hardware", "inference", "foundation-models"],
    {
      domains: ["developer.apple.com", "ml-explore.github.io"],
      repositories: [
        "ml-explore/mlx",
        "ml-explore/mlx-lm",
        "ml-explore/mlx-examples",
      ],
      topics: ["apple mlx", "mlx-lm", "metal performance shaders", "core ml"],
      channels: [
        "framework-docs",
        "metal-docs",
        "model-examples",
        "github-releases",
      ],
    },
  ),
  source(
    "qualcomm-ai",
    "Qualcomm AI",
    "hardware",
    ["hardware", "inference", "embodied-ai"],
    {
      domains: ["aihub.qualcomm.com", "developer.qualcomm.com", "qualcomm.com"],
      repositories: ["quic/ai-hub-models", "quic/aimet"],
      topics: ["qualcomm ai", "snapdragon", "ai hub", "aimet", "hexagon npu"],
      channels: ["hardware-docs", "model-zoo", "sdk-docs", "github-releases"],
    },
  ),
  source(
    "cambricon",
    "Cambricon",
    "hardware",
    ["hardware", "llm-training", "inference"],
    {
      domains: ["cambricon.com"],
      repositories: ["Cambricon/CNStream"],
      topics: ["cambricon", "寒武纪", "mlu", "neuware", "magicmind"],
      channels: ["hardware-docs", "sdk-docs", "release-notes", "github"],
    },
  ),
  source(
    "biren",
    "Biren Technology",
    "hardware",
    ["hardware", "llm-training", "inference"],
    {
      domains: ["birentech.com"],
      repositories: [],
      topics: ["biren", "壁仞", "br100", "br104"],
      channels: ["hardware-updates", "sdk-updates", "product-news"],
    },
  ),
  source(
    "moore-threads",
    "Moore Threads",
    "hardware",
    ["hardware", "llm-training", "inference"],
    {
      domains: ["mthreads.com"],
      repositories: [],
      topics: ["moore threads", "摩尔线程", "musa", "mt-smi"],
      channels: ["hardware-docs", "sdk-docs", "release-notes"],
    },
  ),
  source("d-matrix", "d-Matrix", "hardware", ["hardware", "inference"], {
    domains: ["d-matrix.ai"],
    repositories: [],
    topics: ["d-matrix", "corsair", "digital in-memory compute"],
    channels: ["hardware-updates", "platform-docs", "benchmarks"],
  }),
  source("etched", "Etched", "hardware", ["hardware", "inference"], {
    domains: ["etched.com"],
    repositories: [],
    topics: ["etched", "sohu", "transformer asic"],
    channels: ["hardware-updates", "product-news", "benchmarks"],
  }),
  source("furiosa-ai", "FuriosaAI", "hardware", ["hardware", "inference"], {
    domains: ["furiosa.ai"],
    repositories: ["furiosa-ai/furiosa-sdk"],
    topics: ["furiosa ai", "rngd", "warboy", "npu"],
    channels: ["hardware-docs", "sdk-docs", "release-notes", "github-releases"],
  }),
  source("rebellions", "Rebellions", "hardware", ["hardware", "inference"], {
    domains: ["rebellions.ai"],
    repositories: [],
    topics: ["rebellions", "atom", "rebel", "npu"],
    channels: ["hardware-updates", "sdk-updates", "product-news"],
  }),
  source(
    "graphcore",
    "Graphcore",
    "hardware",
    ["hardware", "llm-training", "inference"],
    {
      domains: ["graphcore.ai"],
      repositories: ["graphcore/examples"],
      topics: ["graphcore", "ipu", "poplar", "popxl"],
      channels: [
        "hardware-docs",
        "sdk-docs",
        "model-examples",
        "github-releases",
      ],
    },
  ),
  source(
    "together-ai",
    "Together AI",
    "cloud",
    ["llm-training", "inference", "foundation-models"],
    {
      domains: ["together.ai", "docs.together.ai"],
      repositories: ["togethercomputer/OpenChatKit"],
      topics: [
        "together ai",
        "inference api",
        "fine tuning",
        "training platform",
      ],
      channels: [
        "api-docs",
        "model-catalog",
        "release-notes",
        "research",
        "github",
      ],
    },
  ),
  source(
    "fireworks-ai",
    "Fireworks AI",
    "cloud",
    ["inference", "agents", "foundation-models"],
    {
      domains: ["fireworks.ai", "docs.fireworks.ai"],
      repositories: [],
      topics: [
        "fireworks ai",
        "fast inference",
        "compound ai",
        "model serving",
      ],
      channels: ["api-docs", "model-catalog", "release-notes", "blog"],
    },
  ),
  source(
    "coreweave",
    "CoreWeave",
    "cloud",
    ["hardware", "llm-training", "inference"],
    {
      domains: ["coreweave.com", "docs.coreweave.com"],
      repositories: ["coreweave/kubernetes-cloud"],
      topics: ["coreweave", "gpu cloud", "kubernetes gpu", "ai cloud"],
      channels: ["cloud-docs", "status", "release-notes", "github-releases"],
    },
  ),
  source(
    "lambda-cloud",
    "Lambda",
    "cloud",
    ["hardware", "llm-training", "inference"],
    {
      domains: ["lambda.ai", "docs.lambda.ai"],
      repositories: [],
      topics: ["lambda cloud", "gpu cloud", "gpu cluster"],
      channels: ["cloud-docs", "hardware-catalog", "release-notes", "status"],
    },
  ),
  source(
    "nebius",
    "Nebius AI",
    "cloud",
    ["hardware", "llm-training", "inference"],
    {
      domains: ["nebius.com", "docs.nebius.com"],
      repositories: [],
      topics: ["nebius ai", "gpu cloud", "ai studio", "managed kubernetes"],
      channels: ["cloud-docs", "release-notes", "status", "github"],
    },
  ),
  source("modal", "Modal", "cloud", ["llm-training", "inference", "agents"], {
    domains: ["modal.com"],
    repositories: ["modal-labs/modal-client"],
    topics: ["modal", "serverless gpu", "model inference", "batch compute"],
    channels: ["docs", "examples", "changelog", "github-releases"],
  }),
  source("baseten", "Baseten", "cloud", ["inference", "agents"], {
    domains: ["baseten.co", "docs.baseten.co"],
    repositories: ["basetenlabs/truss"],
    topics: ["baseten", "truss", "model serving", "inference optimization"],
    channels: ["docs", "model-apis", "changelog", "github-releases"],
  }),
  source(
    "pytorch",
    "PyTorch",
    "runtime",
    ["llm-training", "inference", "research"],
    {
      domains: ["pytorch.org", "docs.pytorch.org"],
      repositories: [
        "pytorch/pytorch",
        "pytorch/torchao",
        "pytorch/torchtune",
        "pytorch/torchchat",
      ],
      topics: [
        "pytorch",
        "torch compile",
        "torchao",
        "torchtune",
        "distributed tensor",
      ],
      channels: ["docs", "release-notes", "RFCs", "issues", "github-releases"],
    },
  ),
  source(
    "jax-openxla",
    "JAX / OpenXLA",
    "runtime",
    ["llm-training", "inference", "hardware", "research"],
    {
      domains: ["docs.jax.dev", "openxla.org"],
      repositories: ["jax-ml/jax", "openxla/xla", "openxla/stablehlo"],
      topics: ["jax", "openxla", "xla", "stablehlo", "pjit", "sharding"],
      channels: ["docs", "release-notes", "RFCs", "github-releases"],
    },
  ),
  source("vllm", "vLLM", "runtime", ["inference"], {
    domains: ["docs.vllm.ai", "vllm.ai"],
    repositories: ["vllm-project/vllm"],
    topics: [
      "vllm",
      "pagedattention",
      "kv cache",
      "continuous batching",
      "distributed serving",
    ],
    channels: [
      "docs",
      "blog",
      "releases",
      "issues",
      "pull-requests",
      "discussions",
    ],
  }),
  source("sglang", "SGLang", "runtime", ["inference", "agents"], {
    domains: ["docs.sglang.ai", "sgl-project.github.io"],
    repositories: ["sgl-project/sglang"],
    topics: ["sglang", "radixattention", "speculative decoding", "llm serving"],
    channels: ["docs", "blog", "releases", "issues", "pull-requests"],
  }),
  source("llama-cpp", "llama.cpp", "runtime", ["inference", "hardware"], {
    domains: [],
    repositories: ["ggml-org/llama.cpp", "ggml-org/ggml"],
    topics: ["llama.cpp", "ggml", "gguf", "local inference"],
    channels: ["releases", "issues", "pull-requests", "discussions"],
  }),
  source("deepspeed", "DeepSpeed", "runtime", ["llm-training", "inference"], {
    domains: ["deepspeed.ai"],
    repositories: ["microsoft/DeepSpeed"],
    topics: ["deepspeed", "zero", "pipeline parallelism", "inference kernel"],
    channels: ["docs", "tutorials", "releases", "issues", "github-releases"],
  }),
  source(
    "triton",
    "Triton Language",
    "runtime",
    ["inference", "hardware", "llm-training"],
    {
      domains: ["triton-lang.org"],
      repositories: ["triton-lang/triton"],
      topics: ["triton language", "gpu kernel", "compiler", "mlir"],
      channels: ["docs", "tutorials", "releases", "issues", "github-releases"],
    },
  ),
  source(
    "flash-attention",
    "FlashAttention",
    "runtime",
    ["llm-training", "inference"],
    {
      domains: [],
      repositories: ["Dao-AILab/flash-attention"],
      topics: ["flashattention", "flash attention", "attention kernel"],
      channels: ["papers", "releases", "issues", "pull-requests"],
    },
  ),
  source(
    "ray",
    "Ray / Anyscale",
    "runtime",
    ["llm-training", "inference", "agents"],
    {
      domains: ["docs.ray.io", "anyscale.com"],
      repositories: ["ray-project/ray", "ray-project/llm-numbers"],
      topics: [
        "ray",
        "ray serve",
        "anyscale",
        "distributed training",
        "llm serving",
      ],
      channels: ["docs", "blog", "releases", "issues", "github-releases"],
    },
  ),
  source(
    "kserve",
    "KServe / Kubernetes AI",
    "runtime",
    ["inference", "hardware"],
    {
      domains: ["kserve.github.io", "kubernetes.io"],
      repositories: [
        "kserve/kserve",
        "kubernetes-sigs/lws",
        "kubernetes-sigs/jobset",
      ],
      topics: [
        "kserve",
        "kubernetes llm",
        "model serving",
        "leaderworker set",
        "jobset",
      ],
      channels: [
        "docs",
        "enhancement-proposals",
        "releases",
        "github-releases",
      ],
    },
  ),
  source("onnx", "ONNX Runtime", "runtime", ["inference", "hardware"], {
    domains: ["onnxruntime.ai", "onnx.ai"],
    repositories: ["microsoft/onnxruntime", "onnx/onnx"],
    topics: [
      "onnx",
      "onnx runtime",
      "execution provider",
      "graph optimization",
    ],
    channels: ["docs", "release-notes", "operator-specs", "github-releases"],
  }),
  source("mlc-llm", "MLC LLM", "runtime", ["inference", "hardware"], {
    domains: ["llm.mlc.ai", "tvm.apache.org"],
    repositories: ["mlc-ai/mlc-llm", "apache/tvm"],
    topics: ["mlc llm", "tvm", "webllm", "mobile inference"],
    channels: ["docs", "blog", "releases", "github-releases"],
  }),
  source("lmdeploy", "LMDeploy", "runtime", ["inference"], {
    domains: ["lmdeploy.readthedocs.io"],
    repositories: ["InternLM/lmdeploy", "InternLM/InternLM"],
    topics: ["lmdeploy", "turbomind", "internlm", "大模型部署"],
    channels: ["docs", "benchmarks", "releases", "github-releases"],
  }),
  source("ollama", "Ollama", "runtime", ["inference", "agents"], {
    domains: ["ollama.com"],
    repositories: ["ollama/ollama"],
    topics: ["ollama", "local model", "local inference"],
    channels: ["model-library", "docs", "releases", "github-releases"],
  }),
  source("world-labs", "World Labs", "lab", ["world-models", "embodied-ai"], {
    domains: ["worldlabs.ai"],
    repositories: [],
    topics: [
      "world labs",
      "world model",
      "spatial intelligence",
      "large world model",
      "3d world",
    ],
    channels: ["research", "product-updates", "demos"],
  }),
  source("runway", "Runway", "lab", ["world-models", "foundation-models"], {
    domains: ["runwayml.com"],
    repositories: ["runwayml/stable-diffusion"],
    topics: [
      "runway",
      "gen video",
      "video generation",
      "world model",
      "general world models",
    ],
    channels: ["research", "product-updates", "model-releases", "demos"],
  }),
  source("luma-ai", "Luma AI", "lab", ["world-models", "embodied-ai"], {
    domains: ["lumalabs.ai"],
    repositories: [],
    topics: ["luma ai", "dream machine", "ray", "3d generation", "world model"],
    channels: ["research", "product-updates", "model-releases", "demos"],
  }),
  source("pika", "Pika", "lab", ["world-models"], {
    domains: ["pika.art"],
    repositories: [],
    topics: ["pika", "video generation", "video model"],
    channels: ["product-updates", "model-releases", "demos"],
  }),
  source("kling-ai", "Kling AI", "lab", ["world-models"], {
    domains: ["klingai.com"],
    repositories: ["KwaiVGI/LivePortrait"],
    topics: ["kling ai", "可灵", "kuaishou video", "video generation"],
    channels: ["product-updates", "model-releases", "research", "demos"],
  }),
  source("moonvalley", "Moonvalley", "lab", ["world-models"], {
    domains: ["moonvalley.com"],
    repositories: [],
    topics: ["moonvalley", "marey", "video generation", "world model"],
    channels: ["research", "model-releases", "product-updates", "demos"],
  }),
  source("decart", "Decart", "lab", ["world-models", "embodied-ai"], {
    domains: ["decart.ai"],
    repositories: [],
    topics: [
      "decart ai",
      "lucy",
      "oasis",
      "real time world model",
      "interactive video",
    ],
    channels: [
      "research",
      "model-releases",
      "interactive-demos",
      "product-updates",
    ],
  }),
  source("odyssey", "Odyssey", "lab", ["world-models", "embodied-ai"], {
    domains: ["odyssey.systems"],
    repositories: [],
    topics: ["odyssey", "interactive video", "world model", "3d worlds"],
    channels: ["research", "interactive-demos", "product-updates"],
  }),
  source("waabi", "Waabi", "robotics", ["world-models", "embodied-ai"], {
    domains: ["waabi.ai"],
    repositories: [],
    topics: [
      "waabi",
      "waabi world",
      "driving simulator",
      "autonomous trucking",
    ],
    channels: ["research", "simulation", "autonomy-updates", "datasets"],
  }),
  source("field-ai", "Field AI", "robotics", ["world-models", "embodied-ai"], {
    domains: ["fieldai.com"],
    repositories: [],
    topics: [
      "field ai",
      "robot foundation model",
      "field robotics",
      "embodied ai",
    ],
    channels: ["research", "robotics-updates", "demos", "deployment"],
  }),
  source(
    "figure-ai",
    "Figure AI",
    "robotics",
    ["world-models", "embodied-ai"],
    {
      domains: ["figure.ai"],
      repositories: [],
      topics: [
        "figure ai",
        "helix",
        "humanoid robot",
        "vision language action",
      ],
      channels: ["research", "robot-updates", "model-releases", "demos"],
    },
  ),
  source("one-x", "1X", "robotics", ["world-models", "embodied-ai"], {
    domains: ["1x.tech"],
    repositories: [],
    topics: ["1x", "neo", "humanoid robot", "world model", "robot learning"],
    channels: ["research", "robot-updates", "demos", "deployment"],
  }),
  source(
    "physical-intelligence",
    "Physical Intelligence",
    "robotics",
    ["world-models", "embodied-ai"],
    {
      domains: ["physicalintelligence.company"],
      repositories: ["Physical-Intelligence/openpi"],
      topics: [
        "physical intelligence",
        "openpi",
        "pi0",
        "vision language action",
        "vla",
      ],
      channels: ["research", "datasets", "robot-policies", "github-releases"],
    },
  ),
  source(
    "waymo-research",
    "Waymo Research",
    "robotics",
    ["world-models", "embodied-ai"],
    {
      domains: ["waymo.com"],
      repositories: ["waymo-research/waymo-open-dataset"],
      topics: [
        "waymo",
        "autonomous driving",
        "driving world model",
        "waymo open dataset",
      ],
      channels: ["research", "datasets", "benchmarks", "github-releases"],
    },
  ),
  source(
    "toyota-research",
    "Toyota Research Institute",
    "robotics",
    ["world-models", "embodied-ai"],
    {
      domains: ["tri.global"],
      repositories: ["TRI-ML/tri-ml"],
      topics: [
        "toyota research",
        "robotics",
        "diffusion policy",
        "autonomous driving",
      ],
      channels: ["research", "datasets", "robotics-updates", "github"],
    },
  ),
  source("skild-ai", "Skild AI", "robotics", ["world-models", "embodied-ai"], {
    domains: ["skild.ai"],
    repositories: [],
    topics: ["skild ai", "robot brain", "general purpose robotics"],
    channels: ["research", "product-updates", "demos"],
  }),
  source(
    "mujoco",
    "MuJoCo",
    "robotics",
    ["world-models", "embodied-ai", "research"],
    {
      domains: ["mujoco.readthedocs.io"],
      repositories: [
        "google-deepmind/mujoco",
        "google-deepmind/mujoco_menagerie",
      ],
      topics: ["mujoco", "physics simulation", "robotics simulator"],
      channels: ["docs", "models", "releases", "github-releases"],
    },
  ),
  source(
    "genesis",
    "Genesis Embodied AI",
    "robotics",
    ["world-models", "embodied-ai"],
    {
      domains: ["genesis-embodied-ai.github.io"],
      repositories: ["Genesis-Embodied-AI/Genesis"],
      topics: ["genesis embodied ai", "robotics simulation", "physics engine"],
      channels: ["docs", "research", "releases", "github-releases"],
    },
  ),
  source(
    "arxiv",
    "arXiv",
    "research",
    ["research", "foundation-models", "world-models", "hardware"],
    {
      domains: ["arxiv.org", "export.arxiv.org"],
      repositories: [],
      topics: [
        "arxiv",
        "preprint",
        "cs.cl",
        "cs.lg",
        "cs.ai",
        "cs.cv",
        "cs.ro",
        "cs.dc",
      ],
      channels: ["search", "recent-submissions", "pdf", "author-pages"],
    },
  ),
  source(
    "openreview",
    "OpenReview",
    "research",
    ["research", "foundation-models", "world-models", "evaluation-safety"],
    {
      domains: ["openreview.net"],
      repositories: [
        "openreview/openreview-py",
        "openreview/openreview-expertise",
      ],
      topics: [
        "openreview",
        "peer review",
        "rebuttal",
        "decision",
        "iclr",
        "neurips",
        "icml",
      ],
      channels: [
        "submissions",
        "reviews",
        "rebuttals",
        "decisions",
        "workshops",
      ],
    },
  ),
  source(
    "acl-anthology",
    "ACL Anthology",
    "research",
    ["research", "foundation-models", "agents"],
    {
      domains: ["aclanthology.org"],
      repositories: ["acl-org/acl-anthology"],
      topics: [
        "acl anthology",
        "acl",
        "emnlp",
        "naacl",
        "computational linguistics",
      ],
      channels: ["papers", "proceedings", "pdf", "github"],
    },
  ),
  source(
    "pmlr",
    "Proceedings of Machine Learning Research",
    "research",
    ["research", "foundation-models", "world-models"],
    {
      domains: ["proceedings.mlr.press"],
      repositories: ["mlresearch/v"],
      topics: [
        "pmlr",
        "icml",
        "aistats",
        "corl",
        "machine learning proceedings",
      ],
      channels: ["papers", "proceedings", "pdf"],
    },
  ),
  source(
    "neurips",
    "NeurIPS",
    "research",
    ["research", "foundation-models", "world-models", "evaluation-safety"],
    {
      domains: ["neurips.cc", "papers.nips.cc"],
      repositories: [],
      topics: [
        "neurips",
        "datasets and benchmarks",
        "machine learning conference",
      ],
      channels: [
        "papers",
        "workshops",
        "datasets-benchmarks",
        "conference-updates",
      ],
    },
  ),
  source(
    "cvf",
    "CVF Open Access",
    "research",
    ["research", "world-models", "embodied-ai"],
    {
      domains: ["openaccess.thecvf.com", "thecvf.com"],
      repositories: [],
      topics: ["cvpr", "iccv", "eccv", "computer vision", "video generation"],
      channels: ["papers", "proceedings", "pdf", "conference-updates"],
    },
  ),
  source(
    "usenix",
    "USENIX",
    "research",
    ["research", "inference", "hardware"],
    {
      domains: ["usenix.org"],
      repositories: [],
      topics: ["usenix", "osdi", "nsdi", "atc", "systems research"],
      channels: ["papers", "talks", "proceedings", "conference-updates"],
    },
  ),
  source(
    "mlcommons",
    "MLCommons",
    "benchmark",
    ["hardware", "inference", "llm-training", "evaluation-safety"],
    {
      domains: ["mlcommons.org"],
      repositories: [
        "mlcommons/inference",
        "mlcommons/training",
        "mlcommons/algorithmic-efficiency",
      ],
      topics: [
        "mlperf",
        "mlcommons",
        "inference benchmark",
        "training benchmark",
      ],
      channels: [
        "benchmark-results",
        "rules",
        "reference-implementations",
        "github-releases",
      ],
    },
  ),
  source(
    "lmsys",
    "LMSYS / Chatbot Arena",
    "benchmark",
    ["foundation-models", "inference", "evaluation-safety"],
    {
      domains: ["lmarena.ai", "lmsys.org"],
      repositories: ["lm-sys/FastChat", "lm-sys/RouteLLM"],
      topics: [
        "lmsys",
        "chatbot arena",
        "lmarena",
        "fastchat",
        "model ranking",
      ],
      channels: ["leaderboards", "datasets", "research", "github-releases"],
    },
  ),
  source("github", "GitHub", "community", ["all"], {
    domains: ["docs.github.com"],
    repositories: ["cli/cli"],
    topics: [
      "github",
      "repository",
      "issue",
      "pull request",
      "discussion",
      "release",
    ],
    channels: [
      "repositories",
      "issues",
      "pull-requests",
      "discussions",
      "releases",
      "commits",
    ],
  }),
  source("bluesky", "Bluesky", "community", ["all"], {
    domains: ["bsky.app", "docs.bsky.app"],
    repositories: ["bluesky-social/atproto"],
    topics: ["bluesky", "atproto", "researcher posts"],
    channels: ["posts", "profiles", "threads", "feeds"],
  }),
  source("x", "X / Twitter", "community", ["all"], {
    domains: ["x.com"],
    repositories: [],
    topics: ["twitter", "x posts", "researcher posts"],
    channels: ["posts", "lists", "profiles", "threads", "spaces"],
  }),
  source("reddit", "Reddit", "community", ["all"], {
    domains: ["reddit.com"],
    repositories: [],
    topics: ["localllama", "machinelearning", "reddit ai"],
    channels: ["posts", "subreddits", "comments"],
  }),
  source("youtube", "YouTube", "community", ["all"], {
    domains: ["youtube.com", "youtu.be"],
    repositories: [],
    topics: ["conference talk", "technical talk", "tutorial", "launch video"],
    channels: ["videos", "channels", "transcripts", "comments"],
  }),
  source("linux-do", "Linux.do", "community", ["all"], {
    domains: ["linux.do"],
    repositories: [],
    topics: ["linux.do", "大模型社区", "ai infra community"],
    channels: ["topics", "posts", "feeds", "tags"],
  }),
  source("zhihu", "Zhihu", "community", ["all"], {
    domains: ["zhihu.com"],
    repositories: [],
    topics: ["知乎", "大模型", "ai 技术讨论"],
    channels: ["questions", "answers", "articles", "topics"],
  }),
  source("bilibili", "Bilibili", "community", ["all"], {
    domains: ["bilibili.com"],
    repositories: [],
    topics: ["bilibili", "技术演讲", "论文解读", "大模型"],
    channels: ["videos", "channels", "comments"],
  }),
] as const;

export const PUBLIC_AI_SOURCE_REFS = [
  "yahoo.search",
  "brave.search",
  "gh.search-repos",
  "gh.search-issues",
  "gh.search-prs",
  "hf.models",
  "hf.datasets",
  "hf.spaces",
  "huggingface-papers.search",
  "arxiv.search",
  "openreview.search",
  "openalex.search",
  "semantic-scholar.search",
  "hackernews.search",
  "bluesky.search-posts",
] as const;

export const AUTHENTICATED_AI_SOURCE_REFS = [
  "twitter.search",
  "reddit.search",
  "linux-do.search",
  "zhihu.search",
  "bilibili.search",
] as const;

export const AI_ROLE_PROFILES: readonly AiRoleProfile[] = [
  {
    id: "all",
    name: "AI field-wide",
    description:
      "Frontier models, training, inference, hardware, agents, evaluation, and embodied/world-model systems.",
    pulseQueries: [
      "large language model",
      "LLM inference",
      "world model embodied AI",
      "AI accelerator",
    ],
    keywords: [
      "language model",
      "llm",
      "multimodal",
      "inference",
      "training",
      "world model",
      "agent",
      "accelerator",
    ],
    sourceRefs: [
      ...PUBLIC_AI_SOURCE_REFS,
      "modelscope.models",
      "opencsg.models",
      "youtube.search",
    ],
  },
  {
    id: "foundation-models",
    name: "Foundation-model research and releases",
    description:
      "Model architecture, pre/post-training, reasoning, multimodality, model cards, weights, APIs, and lab releases.",
    pulseQueries: [
      "large language model reasoning multimodal",
      "foundation model post-training",
    ],
    keywords: [
      "llm",
      "language model",
      "foundation model",
      "reasoning",
      "multimodal",
      "post-training",
      "alignment",
    ],
    sourceRefs: [
      ...PUBLIC_AI_SOURCE_REFS,
      "modelscope.models",
      "modelscope.datasets",
      "opencsg.models",
      "opencsg.datasets",
      "acl-anthology.search",
    ],
  },
  {
    id: "llm-training",
    name: "LLM training systems",
    description:
      "Data, scaling laws, distributed parallelism, optimizers, checkpointing, kernels, failures, cost, and reproducibility.",
    pulseQueries: [
      "LLM training distributed parallelism",
      "pretraining post-training optimizer checkpoint",
    ],
    keywords: [
      "training",
      "pretraining",
      "post-training",
      "parallelism",
      "optimizer",
      "checkpoint",
      "dataset",
      "scaling",
    ],
    sourceRefs: [
      ...PUBLIC_AI_SOURCE_REFS,
      "crossref.search",
      "acl-anthology.search",
      "stackoverflow.search",
    ],
  },
  {
    id: "inference",
    name: "LLM inference and serving",
    description:
      "Latency, throughput, KV cache, batching, quantization, kernels, scheduling, distributed serving, compatibility, and incidents.",
    pulseQueries: ["LLM inference serving", "KV cache quantization GPU kernel"],
    keywords: [
      "inference",
      "serving",
      "latency",
      "throughput",
      "kv cache",
      "batching",
      "quantization",
      "kernel",
      "vllm",
      "sglang",
    ],
    sourceRefs: [
      ...PUBLIC_AI_SOURCE_REFS,
      "stackoverflow.search",
      "lobsters.search",
      "youtube.search",
      "openrouter.search",
    ],
  },
  {
    id: "world-models",
    name: "World models and generative environments",
    description:
      "Video prediction/generation, 3D/4D state, physics, interactive environments, spatial intelligence, planning, datasets, and benchmarks.",
    pulseQueries: [
      "world model video prediction",
      "interactive generative environment spatial intelligence",
    ],
    keywords: [
      "world model",
      "video prediction",
      "video generation",
      "3d",
      "4d",
      "spatial intelligence",
      "simulation",
      "game engine",
    ],
    sourceRefs: [
      ...PUBLIC_AI_SOURCE_REFS,
      "modelscope.models",
      "modelscope.datasets",
      "opencsg.models",
      "opencsg.datasets",
      "acl-anthology.search",
      "youtube.search",
    ],
  },
  {
    id: "embodied-ai",
    name: "Embodied AI and robotics",
    description:
      "Vision-language-action policies, robot learning, simulation, manipulation, navigation, autonomous driving, datasets, and deployment.",
    pulseQueries: [
      "embodied AI robotics VLA",
      "robot learning simulation manipulation",
    ],
    keywords: [
      "embodied ai",
      "robotics",
      "vla",
      "vision language action",
      "robot policy",
      "manipulation",
      "navigation",
      "simulation",
    ],
    sourceRefs: [
      ...PUBLIC_AI_SOURCE_REFS,
      "modelscope.datasets",
      "opencsg.datasets",
      "acl-anthology.search",
      "youtube.search",
    ],
  },
  {
    id: "hardware",
    name: "AI hardware and compilers",
    description:
      "Accelerators, drivers, SDKs, compilers, kernels, memory/interconnect, compatibility, benchmarks, firmware, and security advisories.",
    pulseQueries: [
      "AI accelerator GPU NPU release",
      "CUDA ROCm CANN compiler driver",
    ],
    keywords: [
      "accelerator",
      "gpu",
      "npu",
      "cuda",
      "rocm",
      "cann",
      "driver",
      "compiler",
      "memory",
      "interconnect",
      "mlperf",
    ],
    sourceRefs: [
      "yahoo.search",
      "brave.search",
      "gh.search-repos",
      "gh.search-issues",
      "gh.search-prs",
      "hackernews.search",
      "bluesky.search-posts",
      "youtube.search",
      "arxiv.search",
      "openalex.search",
    ],
  },
  {
    id: "agents",
    name: "AI agents and tool systems",
    description:
      "Tool use, coding agents, retrieval, memory, protocols, orchestration, evaluation, safety, and production reliability.",
    pulseQueries: [
      "AI agent tool use memory",
      "coding agent RAG MCP evaluation",
    ],
    keywords: [
      "agent",
      "tool use",
      "coding agent",
      "rag",
      "memory",
      "mcp",
      "orchestration",
      "browser use",
    ],
    sourceRefs: [
      ...PUBLIC_AI_SOURCE_REFS,
      "stackoverflow.search",
      "lobsters.search",
      "devto.search",
      "youtube.search",
    ],
  },
  {
    id: "evaluation-safety",
    name: "Evaluation, safety, and security",
    description:
      "Benchmarks, leaderboards, red teaming, robustness, interpretability, incidents, advisories, governance, and model-system cards.",
    pulseQueries: [
      "LLM evaluation benchmark safety",
      "AI security red teaming robustness",
    ],
    keywords: [
      "evaluation",
      "benchmark",
      "leaderboard",
      "safety",
      "security",
      "red team",
      "robustness",
      "interpretability",
      "incident",
    ],
    sourceRefs: [
      ...PUBLIC_AI_SOURCE_REFS,
      "crossref.search",
      "acl-anthology.search",
      "stackoverflow.search",
    ],
  },
  {
    id: "research",
    name: "AI research literature",
    description:
      "Preprints, peer review, proceedings, citations, code/data links, rebuttals, decisions, and reproducibility evidence.",
    pulseQueries: [
      "large language model",
      "world model",
      "machine learning systems",
    ],
    keywords: [
      "paper",
      "preprint",
      "peer review",
      "rebuttal",
      "conference",
      "dataset",
      "reproducibility",
    ],
    sourceRefs: [
      "huggingface-papers.search",
      "arxiv.search",
      "openreview.search",
      "openalex.search",
      "semantic-scholar.search",
      "crossref.search",
      "acl-anthology.search",
    ],
  },
] as const;

const CORE_SOURCE_IDS = [
  "openai",
  "anthropic",
  "google-deepmind",
  "meta-ai",
  "hugging-face",
  "nvidia",
  "amd",
  "huawei-ascend",
  "pytorch",
  "vllm",
  "arxiv",
  "openreview",
] as const;

function normalized(value: string): string {
  return value
    .toLowerCase()
    .replaceAll(/[_/.-]+/g, " ")
    .replaceAll(/\s+/g, " ")
    .trim();
}

function domainMatches(hostname: string, domain: string): boolean {
  return hostname === domain || hostname.endsWith(`.${domain}`);
}

export function resolveAiRoleProfile(value: string | undefined): AiRoleProfile {
  const requested = (value ?? "all").trim().toLowerCase();
  const profile = AI_ROLE_PROFILES.find(
    (candidate) => candidate.id === requested,
  );
  if (!profile) {
    throw new Error(`unsupported AI practitioner profile: ${String(value)}`);
  }
  return profile;
}

export function identifyAiPrimarySource(
  url: string,
): AiPrimarySource | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }
  const hostname = parsed.hostname.toLowerCase().replace(/^www\./, "");
  if (hostname === "github.com") {
    const repository = parsed.pathname
      .split("/")
      .filter(Boolean)
      .slice(0, 2)
      .join("/")
      .toLowerCase();
    if (repository) {
      const exact = AI_PRIMARY_SOURCES.find((candidate) =>
        candidate.repositories.some(
          (repo) => repo.toLowerCase() === repository,
        ),
      );
      if (exact) return exact;
    }
  }
  return AI_PRIMARY_SOURCES.flatMap((candidate) =>
    candidate.domains.map((domain) => ({
      candidate,
      domain: domain.toLowerCase().replace(/^www\./, ""),
    })),
  )
    .filter(({ domain }) => domainMatches(hostname, domain))
    .sort((left, right) => right.domain.length - left.domain.length)[0]
    ?.candidate;
}

function explicitSiteDomains(query: string): string[] {
  return [...query.matchAll(/(?:^|\s|\()site:([A-Za-z0-9.-]+)/gi)].map(
    (match) => match[1].toLowerCase().replace(/^www\./, ""),
  );
}

function sourceScore(
  sourceEntry: AiPrimarySource,
  query: string,
  profile: AiRoleProfile,
): number {
  const corpus = normalized(query);
  let score =
    profile.id !== "all" && sourceEntry.roles.includes(profile.id) ? 8 : 0;
  if (sourceEntry.roles.includes("all")) score += 1;
  for (const term of [
    sourceEntry.id,
    sourceEntry.name,
    ...sourceEntry.topics,
  ]) {
    const token = normalized(term);
    if (token && corpus.includes(token)) score += token.split(" ").length + 6;
  }
  for (const domain of sourceEntry.domains) {
    if (query.toLowerCase().includes(domain.toLowerCase())) score += 20;
  }
  for (const repository of sourceEntry.repositories) {
    if (query.toLowerCase().includes(repository.toLowerCase())) score += 20;
  }
  return score;
}

export function selectAiOfficialDomains(
  query: string,
  profileValue?: string,
  limit = 12,
): string[] {
  const explicit = explicitSiteDomains(query);
  if (explicit.length > 0) return [...new Set(explicit)].slice(0, limit);
  const profile = resolveAiRoleProfile(profileValue);
  let ranked = AI_PRIMARY_SOURCES.map((candidate) => ({
    candidate,
    score: sourceScore(candidate, query, profile),
  }))
    .filter(({ candidate, score }) => candidate.domains.length > 0 && score > 0)
    .sort(
      (left, right) =>
        right.score - left.score ||
        left.candidate.id.localeCompare(right.candidate.id),
    );
  if (ranked.length === 0) {
    const fallbackIds =
      profile.id === "all"
        ? new Set<string>(CORE_SOURCE_IDS)
        : new Set(
            AI_PRIMARY_SOURCES.filter((candidate) =>
              candidate.roles.includes(profile.id),
            ).map((candidate) => candidate.id),
          );
    ranked = AI_PRIMARY_SOURCES.filter(
      (candidate) =>
        fallbackIds.has(candidate.id) && candidate.domains.length > 0,
    ).map((candidate, index) => ({
      candidate,
      score: fallbackIds.size - index,
    }));
  }
  const primaryDomains = ranked.map(({ candidate }) => candidate.domains[0]);
  const secondaryDomains = ranked.flatMap(({ candidate }) =>
    candidate.domains.slice(1),
  );
  return [...new Set([...primaryDomains, ...secondaryDomains])].slice(0, limit);
}

export function listAiLandscapeRows(
  profileValue?: string,
): Array<Record<string, unknown>> {
  const profile = profileValue ? resolveAiRoleProfile(profileValue) : undefined;
  return AI_PRIMARY_SOURCES.filter(
    (candidate) =>
      !profile ||
      profile.id === "all" ||
      candidate.roles.includes(profile.id) ||
      candidate.roles.includes("all"),
  ).map((candidate) => ({
    id: candidate.id,
    name: candidate.name,
    type: candidate.type,
    roles: candidate.roles.join(", "),
    domains: candidate.domains.join(", "),
    repositories: candidate.repositories.join(", "),
    channels: candidate.channels.join(", "),
    topics: candidate.topics.join(", "),
    first_party: true,
    next_search: `unicli ai search '${candidate.name}' --profile ${profile?.id ?? candidate.roles.find((role) => role !== "all") ?? "all"}`,
  }));
}

export function listAiProfileRows(): Array<Record<string, unknown>> {
  return AI_ROLE_PROFILES.map((profile) => ({
    profile: profile.id,
    name: profile.name,
    description: profile.description,
    daily_concerns: profile.keywords.join(", "),
    live_sources: profile.sourceRefs.join(", "),
    pulse_queries: profile.pulseQueries.join(" | "),
    next_pulse: `unicli ai pulse --profile ${profile.id}`,
  }));
}
