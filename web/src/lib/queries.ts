import { useQuery } from '@tanstack/react-query';
import { get } from './api';
import type {
  Account,
  ActivityEntry,
  Agent,
  AgentRow,
  Approval,
  CommitRow,
  ConversationRow,
  Decision,
  Doc,
  Message,
  ProjectWithStats,
  Run,
  RunEvent,
  Runner,
  Task,
  UnansweredItem,
} from './types';

export const useMeta = () => useQuery({ queryKey: ['meta'], queryFn: () => get<{ version: string; publicUrl: string; rolePresets: Record<string, { role: string; instructions: string; tool_profile: string }> }>('/api/meta'), staleTime: Infinity });

export interface Overview {
  projects: (ProjectWithStats & { agents: Pick<Agent, 'id' | 'name' | 'slug' | 'role' | 'is_pm' | 'status' | 'status_detail' | 'enabled'>[] })[];
  attention: { approvals: Approval[]; unanswered: UnansweredItem[]; blocked: Task[]; agents: Agent[]; accounts: Account[]; runners: Runner[] };
  recentActivity: ActivityEntry[];
}
export const useOverview = () => useQuery({ queryKey: ['overview'], queryFn: () => get<Overview>('/api/overview') });
export const useProjects = () => useQuery({ queryKey: ['projects'], queryFn: () => get<ProjectWithStats[]>('/api/projects') });
export const useProject = (id: string) => useQuery({ queryKey: ['project', id], queryFn: () => get<ProjectWithStats>(`/api/projects/${id}`) });
export const useAgents = (projectId: string) => useQuery({ queryKey: ['agents', projectId], queryFn: () => get<AgentRow[]>(`/api/projects/${projectId}/agents`), enabled: !!projectId });
export const useAgent = (id: string | null) => useQuery({ queryKey: ['agent', id], queryFn: () => get<Agent & { sessions: any[]; inbox: any[]; runs: Run[] }>(`/api/agents/${id}`), enabled: !!id });
export const useTasks = (projectId: string) => useQuery({ queryKey: ['tasks', projectId], queryFn: () => get<Task[]>(`/api/projects/${projectId}/tasks`) });
export interface TaskDetail extends Task {
  conversation_id: string;
  subtasks: Task[];
  dependents: Pick<Task, 'id' | 'key' | 'title' | 'status'>[];
  commits: CommitRow[];
  runs: Pick<Run, 'id' | 'kind' | 'agent_id' | 'status' | 'trigger' | 'error_kind' | 'queued_at' | 'finished_at'>[];
  approvals: Approval[];
  activity: ActivityEntry[];
}
export const useTask = (id: string | null) => useQuery({ queryKey: ['task', id], queryFn: () => get<TaskDetail>(`/api/tasks/${id}`), enabled: !!id });
export const useConversations = (projectId: string) => useQuery({ queryKey: ['conversations', projectId], queryFn: () => get<ConversationRow[]>(`/api/projects/${projectId}/conversations`) });
export const useMessages = (conversationId: string | null) =>
  useQuery({ queryKey: ['messages', conversationId], queryFn: () => get<Message[]>(`/api/conversations/${conversationId}/messages`), enabled: !!conversationId });
export const useApprovals = (projectId?: string, status?: string) =>
  useQuery({ queryKey: ['approvals', projectId ?? 'all', status ?? 'any'], queryFn: () => get<Approval[]>(`/api/approvals?${new URLSearchParams({ ...(projectId ? { project: projectId } : {}), ...(status ? { status } : {}) })}`) });
export const useRuns = (projectId: string) => useQuery({ queryKey: ['runs', projectId], queryFn: () => get<Run[]>(`/api/projects/${projectId}/runs?limit=200`) });
export const useRun = (id: string | null) => useQuery({ queryKey: ['run', id], queryFn: () => get<Run & { inbox: any[] }>(`/api/runs/${id}`), enabled: !!id });
export const useRunEvents = (id: string | null) => useQuery({ queryKey: ['runEvents', id], queryFn: () => get<RunEvent[]>(`/api/runs/${id}/events`), enabled: !!id });
export const useActivity = (projectId: string) => useQuery({ queryKey: ['activity', projectId], queryFn: () => get<ActivityEntry[]>(`/api/projects/${projectId}/activity?limit=300`) });
export const useDocs = (projectId: string) => useQuery({ queryKey: ['docs', projectId], queryFn: () => get<(Omit<Doc, 'body'> & { size: number })[]>(`/api/projects/${projectId}/docs`) });
export const useDoc = (projectId: string, slug: string | null) => useQuery({ queryKey: ['doc', projectId, slug], queryFn: () => get<Doc>(`/api/projects/${projectId}/docs/${slug}`), enabled: !!slug });
export const useDecisions = (projectId: string) => useQuery({ queryKey: ['decisions', projectId], queryFn: () => get<Decision[]>(`/api/projects/${projectId}/decisions`) });
export const useGit = (projectId: string) =>
  useQuery({
    queryKey: ['git', projectId],
    queryFn: () =>
      get<{ base_branch: string; repo_url: string | null; branches: { branch: string; task: Pick<Task, 'id' | 'key' | 'title' | 'status' | 'merge_state'>; assignee_id: string | null }[]; commits: CommitRow[]; merges: Run[] }>(`/api/projects/${projectId}/git`),
  });
export const useAccounts = () => useQuery({ queryKey: ['accounts'], queryFn: () => get<Account[]>('/api/accounts') });
export const useRunners = () => useQuery({ queryKey: ['runners'], queryFn: () => get<Runner[]>('/api/runners') });
