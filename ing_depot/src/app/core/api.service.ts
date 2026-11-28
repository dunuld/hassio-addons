import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import type {
  Depot,
  DepotDocument,
  DepotUpdate,
  DividendCalendar,
  HealthResponse,
  ImportFailure,
  ImportResult,
  OpeningInput,
  PriceUpdateStatus,
  Overview,
  PriceInput,
  SecurityUpdate,
  Transaction,
} from '../../../shared/api-types';

/** Zugriff auf die REST-API; Pfade relativ, damit sie unter dem HA-Ingress-Pfad funktionieren. */
@Injectable({ providedIn: 'root' })
export class ApiService {
  private readonly http = inject(HttpClient);

  health() {
    return this.http.get<HealthResponse>('api/health');
  }

  overview(year?: number, depot?: number | null) {
    const params: Record<string, number> = {};
    if (year) params['year'] = year;
    if (depot) params['depot'] = depot;
    return this.http.get<Overview>('api/overview', { params });
  }

  dividends(year?: number, depot?: number | null) {
    const params: Record<string, number> = {};
    if (year) params['year'] = year;
    if (depot) params['depot'] = depot;
    return this.http.get<DividendCalendar>('api/dividends', { params });
  }

  depots() {
    return this.http.get<Depot[]>('api/depots');
  }

  updateDepot(id: number, update: DepotUpdate) {
    return this.http.put<Depot>(`api/depots/${id}`, update);
  }

  transactions(depot?: number | null) {
    return this.http.get<Transaction[]>('api/transactions', {
      params: depot ? { depot } : {},
    });
  }

  addOpening(input: OpeningInput) {
    return this.http.post<Transaction>('api/transactions', input);
  }

  deleteTransaction(id: number) {
    return this.http.delete<void>(`api/transactions/${id}`);
  }

  documents() {
    return this.http.get<DepotDocument[]>('api/documents');
  }

  uploadDocuments(files: File[]) {
    const form = new FormData();
    files.forEach((file) => form.append('files', file, file.name));
    return this.http.post<ImportResult[]>('api/documents', form);
  }

  deleteDocument(id: number) {
    return this.http.delete<void>(`api/documents/${id}`);
  }

  /** Relativer Link zur gespeicherten Original-PDF. */
  documentUrl(id: number): string {
    return `api/documents/${id}/file`;
  }

  scanInbox() {
    return this.http.post<ImportResult[]>('api/inbox/scan', {});
  }

  importFailures() {
    return this.http.get<ImportFailure[]>('api/import-failures');
  }

  deleteImportFailure(id: number) {
    return this.http.delete<void>(`api/import-failures/${id}`);
  }

  priceStatus() {
    return this.http.get<PriceUpdateStatus>('api/prices/status');
  }

  refreshPrices() {
    return this.http.post<PriceUpdateStatus>('api/prices/refresh', {});
  }

  addPrice(isin: string, input: PriceInput) {
    return this.http.post<void>(`api/securities/${isin}/prices`, input);
  }

  updateSecurity(isin: string, update: SecurityUpdate) {
    return this.http.put<void>(`api/securities/${isin}`, update);
  }
}
