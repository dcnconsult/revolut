import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import type { SandboxInternalTransferService } from '../../services/sandbox-internal-transfer-service.js';

const TransferRequestSchema = z.object({
  sourceAccountId: z.string().uuid(),
  targetAccountId: z.string().uuid(),
  amountMinor: z.number().int().positive(),
  currency: z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/),
  reference: z.string().trim().min(1).max(140),
  clientReference: z.string().trim().min(8).max(64)
});
const ListQuerySchema = z.object({
  limit: z.coerce.number().int().positive().max(500).default(100)
});

export async function sandboxInternalTransferRoutes(
  app: FastifyInstance,
  service: SandboxInternalTransferService
) {
  app.get('/sandbox/accounts', async (_request, reply) => {
    try {
      return reply.send(await service.listAccounts());
    } catch (error) {
      return reply.code(502).send({ error: 'sandbox_provider_error', message: (error as Error).message });
    }
  });

  app.post('/sandbox/internal-transfers/prepare', async (request, reply) => {
    const parsed = TransferRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'validation_error', details: parsed.error.flatten() });
    }
    try {
      return reply.code(201).send(await service.prepare(parsed.data));
    } catch (error) {
      return reply.code(422).send({ error: 'sandbox_transfer_rejected', message: (error as Error).message });
    }
  });

  app.post<{ Params: { id: string } }>('/sandbox/internal-transfers/:id/submit', async (request, reply) => {
    try {
      return reply.send(await service.submit(request.params.id));
    } catch (error) {
      return reply.code(409).send({ error: 'sandbox_submission_rejected', message: (error as Error).message });
    }
  });

  app.post<{ Params: { id: string } }>('/sandbox/internal-transfers/:id/reconcile', async (request, reply) => {
    try {
      return reply.send(await service.reconcile(request.params.id));
    } catch (error) {
      return reply.code(404).send({ error: 'sandbox_transfer_not_found', message: (error as Error).message });
    }
  });

  app.get<{ Params: { id: string } }>('/sandbox/internal-transfers/:id', async (request, reply) => {
    try {
      return reply.send(service.get(request.params.id));
    } catch (error) {
      return reply.code(404).send({ error: 'sandbox_transfer_not_found', message: (error as Error).message });
    }
  });

  app.get('/sandbox/monitoring/summary', async () => service.monitoringSummary());

  app.get<{ Querystring: { limit?: string } }>('/sandbox/monitoring/transfers', async (request, reply) => {
    const parsed = ListQuerySchema.safeParse(request.query);
    if (!parsed.success) return reply.code(400).send({ error: 'validation_error' });
    return service.listTransfers(parsed.data.limit);
  });

  app.get<{ Querystring: { limit?: string } }>('/sandbox/monitoring/audit-events', async (request, reply) => {
    const parsed = ListQuerySchema.safeParse(request.query);
    if (!parsed.success) return reply.code(400).send({ error: 'validation_error' });
    return service.listAuditEvents(parsed.data.limit);
  });

  app.get('/sandbox/monitoring', async (_request, reply) => reply
    .type('text/html; charset=utf-8')
    .send(monitoringPage));
}

const monitoringPage = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>Revolut Sandbox Monitor</title>
<style>
body{font:15px system-ui;margin:2rem;background:#111827;color:#e5e7eb}h1{font-size:1.5rem}
.card{background:#1f2937;border:1px solid #374151;border-radius:10px;padding:1rem;margin:1rem 0}
table{width:100%;border-collapse:collapse}th,td{text-align:left;padding:.55rem;border-bottom:1px solid #374151}
.ok{color:#6ee7b7}.muted{color:#9ca3af}code{font-size:.85em}button{padding:.5rem .8rem}
</style></head><body><h1>Revolut Sandbox Monitor</h1>
<p class="muted">Loopback-only audit view. Refreshes every 30 seconds.</p>
<div class="card" id="summary">Loading…</div>
<div class="card"><h2>Transfers</h2><table><thead><tr><th>Updated</th><th>Reference</th><th>Amount</th><th>State</th></tr></thead><tbody id="transfers"></tbody></table></div>
<div class="card"><h2>Audit events</h2><table><thead><tr><th>Time</th><th>Event</th><th>State</th></tr></thead><tbody id="events"></tbody></table></div>
<script>
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
async function load(){
 const [s,t,e]=await Promise.all(['/summary','/transfers?limit=50','/audit-events?limit=100'].map(p=>fetch('/v1/sandbox/monitoring'+p).then(r=>r.json())));
 document.querySelector('#summary').innerHTML='<b class="ok">Sandbox monitoring active</b><br>Total transfers: '+esc(s.total)+'<br>States: <code>'+esc(JSON.stringify(s.byState))+'</code>';
 document.querySelector('#transfers').innerHTML=t.map(x=>'<tr><td>'+esc(x.updatedAt)+'</td><td>'+esc(x.request.clientReference)+'</td><td>'+esc(x.request.amountMinor)+' '+esc(x.request.currency)+' minor</td><td>'+esc(x.state)+'</td></tr>').join('');
 document.querySelector('#events').innerHTML=e.map(x=>'<tr><td>'+esc(x.createdAt)+'</td><td>'+esc(x.eventType)+'</td><td>'+esc(x.state)+'</td></tr>').join('');
} load(); setInterval(load,30000);
</script></body></html>`;
