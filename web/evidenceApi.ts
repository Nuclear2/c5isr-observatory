import type { BatchRow, LabArchive, LabBranch, LabConfig, RecordedAdvice } from '../contracts/evidence';
import { request } from './api';

export const runEvidenceLab = (config: LabConfig) =>
  request<LabArchive>('/api/evidence/run', config);

export const runEvidenceBatch = (config: LabConfig, count: number) =>
  request<BatchRow[]>('/api/evidence/batch', { config, count });

export const requestEvidenceAdvice = (config: LabConfig, branch: LabBranch, tick: number, requestId: string) =>
  request<RecordedAdvice>('/api/evidence/advice', { config, branch, tick, request_id: requestId });

export const cancelEvidenceAdvice = async (requestId: string): Promise<void> => {
  await request('/api/evidence/advice/cancel', { request_id: requestId });
};
