import type { Row } from '../db/db.js';
import { parseJson } from '../util/util.js';
import {
  DEFAULT_LIMITS,
  type Account,
  type ActivityEntry,
  type Agent,
  type Approval,
  type Conversation,
  type Decision,
  type Doc,
  type InboxItem,
  type Message,
  type Project,
  type Run,
  type Runner,
  type Task,
} from './types.js';

const b = (v: unknown) => v === 1 || v === true;
const omit = (r: Row, keys: string[]) => Object.fromEntries(Object.entries(r).filter(([k]) => !keys.includes(k)));

export const toProject = (r: Row): Project => ({
  ...(omit(r, ['github_token_enc']) as any),
  has_github_token: !!r.github_token_enc,
  push_on_merge: b(r.push_on_merge),
  archived: b(r.archived),
  limits: { ...DEFAULT_LIMITS, ...parseJson(r.limits, {}) },
});

export const toAgent = (r: Row): Agent => ({ ...(r as any), is_pm: b(r.is_pm), enabled: b(r.enabled) });

export const toAccount = (r: Row): Account => ({
  ...(omit(r, ['fire_token_enc', 'cloud_token_hash']) as any),
  has_fire_token: !!r.fire_token_enc,
  has_cloud_token: !!r.cloud_token_hash,
  usage: parseJson(r.usage, {}),
  auth: parseJson(r.auth, {}),
});

export const toRunner = (r: Row): Runner => {
  const { token_hash: _t, ...rest } = r;
  return { ...(rest as any), info: parseJson(r.info, {}) };
};

export const toTask = (r: Row): Task => ({ ...(r as any), continue_requested: b(r.continue_requested) });

export const toConversation = (r: Row): Conversation => ({ ...(r as any), loop_guard_tripped: b(r.loop_guard_tripped) });

export const toMessage = (r: Row): Message => ({ ...(r as any), expects_reply: b(r.expects_reply) });

export const toInbox = (r: Row): InboxItem => ({ ...(r as any), wake: b(r.wake) });

export const toRun = (r: Row): Run => {
  const { token_hash: _t, ...rest } = r;
  return {
    ...(rest as any),
    payload: parseJson(r.payload, {}),
    usage: parseJson(r.usage, {}),
    git: parseJson(r.git, {}),
    cancel_requested: b(r.cancel_requested),
  };
};

export const toApproval = (r: Row): Approval => ({ ...(r as any), payload: parseJson(r.payload, {}) });
export const toDecision = (r: Row): Decision => r as any;
export const toDoc = (r: Row): Doc => r as any;
export const toActivity = (r: Row): ActivityEntry => ({ ...(r as any), data: parseJson(r.data, {}) });
