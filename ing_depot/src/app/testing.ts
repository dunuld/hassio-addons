import type { HttpTestingController } from '@angular/common/http/testing';
import type { Depot } from '../../shared/api-types';

/** Testdaten eines Depots. */
export function depotFixture(patch: Partial<Depot> = {}): Depot {
  const number = patch.number ?? '1234567890';
  return {
    id: 1,
    number,
    label: null,
    displayName: `Depot ${number}`,
    startDocumentId: null,
    startDate: null,
    documentCount: 1,
    statements: [],
    ...patch,
  };
}

/** Beantwortet alle offenen Anfragen nach der Depotliste. */
export function flushDepots(http: HttpTestingController, depots: Depot[] = []): void {
  http.match('api/depots').forEach((req) => req.flush(depots));
}
