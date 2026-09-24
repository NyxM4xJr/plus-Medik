import type {
  ExistingLabTest,
  LabTestPatch,
  LabTestRepository,
  LabTestValues,
} from '@/lib/catalog/import';

export type RepositoryOperation =
  | { op: 'insert'; rows: LabTestValues[] }
  | { op: 'update'; id: string; patch: LabTestPatch };

/** lab_tests simulado en memoria. Registra cada escritura. */
export function createMemoryLabTests(initial: ExistingLabTest[] = []) {
  let rows: ExistingLabTest[] = initial.map((row) => ({ ...row }));
  let nextId = 1;
  const operations: RepositoryOperation[] = [];

  const repository: LabTestRepository = {
    async list() {
      return rows.map((row) => ({ ...row }));
    },
    async insert(values) {
      operations.push({ op: 'insert', rows: values.map((value) => ({ ...value })) });
      rows = [...rows, ...values.map((value) => ({ id: `new-${nextId++}`, ...value }))];
    },
    async update(id, patch) {
      operations.push({ op: 'update', id, patch: { ...patch } });
      rows = rows.map((row) => (row.id === id ? { ...row, ...patch } : row));
    },
  };

  return {
    repository,
    operations,
    snapshot: () => rows.map((row) => ({ ...row })),
  };
}
