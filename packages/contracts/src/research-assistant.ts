export const RESEARCH_ASSISTANT_ID = 'ai-research-assistant'
export const RESEARCH_FILE_MAX_BYTES = 5 * 1024 * 1024
export const RESEARCH_FILE_ACCEPT = '.png,.jpg,.jpeg,.webp,.pdf,.docx,.doc,.txt,.md'

export interface ResearchAttachment {
  id: string
  name: string
  path: string
  bytes: number
  mediaType: string
}

export const RESEARCH_STARTERS = [
  { title: '行业与产业链', icon: '研', question: '帮我梳理存储行业的主要上市公司、上下游关系，以及值得继续核实的供需变化。' },
  { title: '市场与情绪', icon: '势', question: '结合最新可核实的市场数据，分析市场宽度、连板梯队和题材情绪，区分事实与推断。' },
  { title: '公告与财报', icon: '报', question: '请解读我提供的公告或财报，提炼核心变化、盈利质量、现金流与风险，并标明原文依据。' },
  { title: '公司对比', icon: '比', question: '请比较两家公司的商业模式、盈利质量、估值口径和主要风险。先帮我确定需要哪些资料。' },
] as const
