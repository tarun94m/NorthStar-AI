import type { ModelTaskType } from './model-registry.js';

export type PublicTaskType = Exclude<ModelTaskType, 'conversation_summarization' | 'memory_extraction'>;
export type TaskClassification = {
  taskType: PublicTaskType;
  requiredCapabilities: string[];
  reasonCode: string;
  classificationSource: 'explicit' | 'deterministic' | 'default';
};

const publicTaskTypes: PublicTaskType[] = [
  'general_conversation', 'complex_reasoning', 'coding', 'writing', 'document_analysis',
  'research', 'vision', 'structured_extraction', 'tool_intensive',
];
const matches = (text: string, pattern: RegExp) => pattern.test(text);

export function classifyTask(text: string, explicitTask?: PublicTaskType): TaskClassification {
  const value = text.toLowerCase();
  if (explicitTask) return requirements(explicitTask, value, 'explicit_task_type', 'explicit');
  if (matches(value, /\b(image|picture|photo|screenshot|visual|diagram|look at this)\b/)) return requirements('vision', value, 'image_request', 'deterministic');
  if (matches(value, /\b(run this|execute|call (an? )?api|use (a )?tool|browse the web|search the web)\b/)) return requirements('tool_intensive', value, 'tool_execution_request', 'deterministic');
  if (matches(value, /\b(extract|parse|convert)\b.{0,80}\b(json|schema|fields|structured|csv)\b|\b(json|schema)\b.{0,80}\b(extract|parse|convert|return)\b/)) return requirements('structured_extraction', value, 'structured_extraction_request', 'deterministic');
  if (matches(value, /\b(research|sources?|citations?|latest|up.to.date|online|internet|web search)\b|\bcurrent\s+(?:(?:[a-z][a-z-]*)\s+){0,2}(?:information|news|events?|status|prices?|pricing|versions?|conditions?)\b/)) return requirements('research', value, 'research_request', 'deterministic');
  if (matches(value, /\b(document|contract|report|paper|transcript|pdf|attachment|file)\b/)) return requirements('document_analysis', value, 'document_analysis_request', 'deterministic');
  if (matches(value, /\b(debug|bug|compile|typescript|javascript|python|sql|code|function|stack trace|test failure|refactor)\b/)) return requirements('coding', value, 'coding_request', 'deterministic');
  if (matches(value, /\b(write|draft|rewrite|edit|proofread|compose|story|email|blog|copy)\b/)) return requirements('writing', value, 'writing_request', 'deterministic');
  if (matches(value, /\b(prove|derive|multi.step|step.by.step|analyze deeply|reason through|trade.off)\b/)) return requirements('complex_reasoning', value, 'reasoning_request', 'deterministic');
  return requirements('general_conversation', value, 'general_default', 'default');
}

function requirements(taskType: PublicTaskType, text: string, reasonCode: string, classificationSource: TaskClassification['classificationSource']): TaskClassification {
  const requiredCapabilities: string[] = [];
  if (taskType === 'vision') requiredCapabilities.push('imageInput');
  if (taskType === 'tool_intensive') requiredCapabilities.push('toolCalling');
  if (taskType === 'structured_extraction' && /\b(json|schema|structured|csv)\b/.test(text)) requiredCapabilities.push('structuredOutput');
  if (taskType === 'research' && /\b(latest|up.to.date|online|internet|web|sources?|citations?)\b|\bcurrent\s+(?:(?:[a-z][a-z-]*)\s+){0,2}(?:information|news|events?|status|prices?|pricing|versions?|conditions?)\b/.test(text)) requiredCapabilities.push('webSearch');
  if (taskType === 'document_analysis' && /\b(attachment|attached|upload|pdf|file)\b/.test(text)) requiredCapabilities.push('documentInput');
  return { taskType, requiredCapabilities, reasonCode, classificationSource };
}

export function isPublicTaskType(value: string): value is PublicTaskType {
  return publicTaskTypes.includes(value as PublicTaskType);
}
