import { complete } from '../llm/openai.js';
import { supabase } from '../supabase.js';
import type { HistoryTurn } from '../llm/reply.js';

export interface AppointmentService {
  identifier: string;
  title: string;
  subtitle?: string;
}

export interface AppointmentSlot {
  identifier: string;
  label: string;
  startsAt?: string;
  durationSeconds?: number;
  locationTitle?: string;
}

export interface AppointmentContext {
  conversationId: string | null;
  agentId: string;
  customerId: string;
  customerName?: string;
  service?: AppointmentService | null;
  slot?: AppointmentSlot | null;
  status?: 'collecting' | 'scheduled' | 'payment_requested' | 'confirmed';
  paymentStatus?: 'not_required' | 'requested' | 'preview_only' | 'paid';
  paymentAmount?: string;
  paymentCurrency?: string;
  history: HistoryTurn[];
}

let schemaReady: boolean | null = null;
let warned = false;

async function ready(): Promise<boolean> {
  if (schemaReady !== null) return schemaReady;
  const { error } = await supabase.from('appointments').select('id').limit(1);
  schemaReady = !error;
  if (!schemaReady && !warned) {
    warned = true;
    console.warn('[appointments] migration 0006 not applied; skipping booking persistence.');
  }
  return schemaReady;
}

function latestCustomerText(history: HistoryTurn[]): string {
  return history
    .filter((turn) => turn.role === 'customer')
    .slice(-8)
    .map((turn) => turn.text)
    .join('\n')
    .slice(0, 2000);
}

async function extractPatientDetails(history: HistoryTurn[]): Promise<Record<string, unknown>> {
  const text = latestCustomerText(history);
  if (!text) return {};
  try {
    const raw = await complete(
      [
        {
          role: 'system',
          content:
            'Extract appointment booking details from dental patient chat. Return only JSON with keys: patientName, phone, email, dateOfBirth, insuranceProvider, reason, symptoms, urgency, notes. Use null for unknown values. Do not infer medical facts.',
        },
        { role: 'user', content: text },
      ],
      { json: true },
    );
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch (err) {
    console.warn('[appointments] extraction failed:', err);
    return {};
  }
}

export async function upsertAppointment(ctx: AppointmentContext): Promise<void> {
  if (!ctx.conversationId || !(await ready())) return;

  const patientDetails = await extractPatientDetails(ctx.history);
  const patch: Record<string, unknown> = {
    conversation_id: ctx.conversationId,
    agent_id: ctx.agentId,
    customer_id: ctx.customerId,
    customer_name: ctx.customerName ?? 'Apple Customer',
    updated_at: new Date().toISOString(),
    patient_details: patientDetails,
    extraction: {
      source: 'llm',
      extractedAt: new Date().toISOString(),
    },
  };

  if (ctx.service) {
    patch.service_identifier = ctx.service.identifier;
    patch.service_title = ctx.service.title;
    patch.service_subtitle = ctx.service.subtitle ?? null;
  }
  if (ctx.slot) {
    patch.slot_identifier = ctx.slot.identifier;
    patch.starts_at = ctx.slot.startsAt ?? null;
    patch.duration_seconds = ctx.slot.durationSeconds ?? null;
    patch.location_title = ctx.slot.locationTitle ?? null;
  }
  if (ctx.status) patch.status = ctx.status;
  if (ctx.paymentStatus) patch.payment_status = ctx.paymentStatus;
  if (ctx.paymentAmount) patch.payment_amount = ctx.paymentAmount;
  if (ctx.paymentCurrency) patch.payment_currency = ctx.paymentCurrency;

  try {
    const { error } = await supabase.rpc('upsert_appointment_for_conversation', {
      p_patch: patch,
    });
    if (error) throw error;
  } catch (err) {
    console.warn('[appointments] atomic upsert failed:', err);
  }
}
