export type PriceMode = 'TARGET_PAYMENTS' | 'PRICE_PER_KG' | 'CLIENT_PRICELIST' | 'KGD_INDICATIVE';

export type InvoiceStatus =
  | 'CREATED'
  | 'UPLOADED'
  | 'PROCESSING'
  | 'REVIEW'
  | 'APPROVED'
  | 'FAILED'
  | 'CANCELED';

export interface InvoiceItem {
  index: number;
  article: string;
  text_original: string;
  text_translated: string;
  quantity: number;
  gross_kg: number;
  net_kg: number;
  tnved_code: string;
  tnved_description: string;
  duty_rate: number;
  confidence: number;
  needs_review: boolean;
  review_reason?: string;
  reasoning?: string;
  alternatives?: Array<{ code: string; description: string }>;
}

export interface InvoiceSummary {
  items_count: number;
  codes_count: number;
  gross_kg: number;
  net_kg: number;
  units_total: number;
  cost_usd: number;
  duty_usd: number;
  vat_usd: number;
  fee_usd: number;
  total_payments_usd: number;
  target_usd?: number;
}

export interface InvoiceState {
  id: string;
  invoice_number: string | null;
  client_name: string;
  status: InvoiceStatus;
  price_mode: PriceMode | null;
  price_value: number | null;
  summary: InvoiceSummary | null;
  items: InvoiceItem[] | null;
  result_file_url: string | null;
  created_at: string;
  updated_at: string;
  // DB-side fields, populated by Supabase queries.
  assigned_to?: string | null;
  created_by?: string | null;
  reassigned_from?: string | null;
}

export interface UploadInput {
  clientName: string;
  fileName: string;
  fileUrl?: string;
  telegramChatId: number;
  createdById: string;
  assignedToId: string;
}

export interface UploadResult {
  invoiceId: string;
  invoiceNumber: string;
  itemsCount: number;
  grossKg: number;
  unitsTotal: number;
}

export interface ApproveResult {
  filePath: string;
  fileName: string;
}

export interface TnvedHit {
  code: string;
  description: string;
  duty_rate: number;
}

export interface ApiClient {
  uploadFile(input: UploadInput): Promise<UploadResult>;
  classify(invoiceId: string, mode: PriceMode, value?: number): Promise<void>;
  getInvoice(invoiceId: string): Promise<InvoiceState>;
  patchItem(invoiceId: string, itemIndex: number, newCode: string): Promise<void>;
  approve(invoiceId: string): Promise<ApproveResult>;
  listClients(): Promise<string[]>;
  searchTnved(query: string): Promise<TnvedHit[]>;
}
