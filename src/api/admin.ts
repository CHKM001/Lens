import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify'
import { randomBytes } from 'crypto'
import { z } from 'zod'
import { prisma } from '../db'
import { admin_auth_failures_total } from '../metrics'
import { formatValidationError } from '../validation'
import { hashApiKey, isAdminAuthorized } from './auth'

/** Generates a new opaque API key with a recognizable `lens_` prefix. */
export function generateApiKey(): string {
  return `lens_${randomBytes(24).toString('hex')}`
}

interface CreateKeyBody {
  label?: string
  expiresAt?: string
  ratePerMin?: number
  ratePerDay?: number
  monthlyQuotaCents?: number
  dailyQuotaCents?: number
  overagePolicy?: 'block' | 'charge_402' | 'allow_overage'
}

/** The only overage policies `src/x402/metering.ts` understands. */
const OVERAGE_POLICIES = ['block', 'charge_402', 'allow_overage'] as const

// Rates and quota cents are stored in Postgres `Int` columns (32-bit signed), so
// their value cannot exceed this without overflowing the column anyway.
const MAX_INT32 = 2_147_483_647

/**
 * A rate or quota: a positive integer within the `Int` column's range. Rejects
 * zero, negatives, and fractions rather than coercing them, so a mistake fails
 * loudly at creation instead of silently minting a key that can never call
 * anything or one that is never limited.
 */
const quotaField = (name: string) =>
  z
    .number({ error: `${name} must be a positive integer` })
    .int({ error: `${name} must be a positive integer` })
    .min(1, { error: `${name} must be a positive integer` })
    .max(MAX_INT32, { error: `${name} must be at most ${MAX_INT32}` })

/**
 * Validates the `POST /admin/keys` body and rejects rather than coerces. Every
 * field a caller can send is checked here so nothing reaches the database
 * unvalidated (see issue #506).
 */
const CreateKeySchema = z
  .object({
    label: z.string({ error: 'label is required' }).trim().min(1, { error: 'label is required' }),
    expiresAt: z.string({ error: 'expiresAt must be a valid future date' }).optional(),
    ratePerMin: quotaField('ratePerMin').optional(),
    ratePerDay: quotaField('ratePerDay').optional(),
    monthlyQuotaCents: quotaField('monthlyQuotaCents').optional(),
    dailyQuotaCents: quotaField('dailyQuotaCents').optional(),
    overagePolicy: z
      .enum(OVERAGE_POLICIES, {
        error: `overagePolicy must be one of: ${OVERAGE_POLICIES.join(', ')}`,
      })
      .optional(),
  })
  .superRefine((data, ctx) => {
    if (data.expiresAt !== undefined) {
      const t = new Date(data.expiresAt).getTime()
      if (!Number.isFinite(t) || t <= Date.now()) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['expiresAt'],
          message: 'expiresAt must be a valid future date',
        })
      }
    }
    // A per-day cap below the per-minute cap can never bind and is always a mistake.
    if (
      data.ratePerMin !== undefined &&
      data.ratePerDay !== undefined &&
      data.ratePerDay < data.ratePerMin
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['ratePerDay'],
        message: 'ratePerDay must be greater than or equal to ratePerMin',
      })
    }
  })

/**
 * Registers admin-only endpoints for minting and revoking API keys.
 *
 * - `POST /admin/keys`   — mint a new key (returns the plaintext key ONCE).
 * - `DELETE /admin/keys/:id` — revoke an existing key.
 *
 * All routes are marked `config.public = true` so the API-key auth hook skips
 * them; they enforce their own `ADMIN_TOKEN` check instead.
 */
export async function registerAdminRoutes(app: FastifyInstance) {
  app.post<{ Body: CreateKeyBody }>(
    '/admin/keys',
    { config: { public: true } },
    async (req: FastifyRequest<{ Body: CreateKeyBody }>, reply: FastifyReply) => {
      if (!isAdminAuthorized(req)) {
        admin_auth_failures_total.inc()
        return reply.status(401).send({
          error: 'Unauthorized',
          code: 'admin_unauthorized',
          message: 'Provide a valid X-Admin-Token header.',
        })
      }

      const parsed = CreateKeySchema.safeParse(req.body ?? {})
      if (!parsed.success) {
        return reply.status(400).send(formatValidationError(parsed.error))
      }
      const { label, expiresAt, ratePerMin, ratePerDay, monthlyQuotaCents, dailyQuotaCents, overagePolicy } = parsed.data
      const expiration = expiresAt === undefined ? undefined : new Date(expiresAt)

      // Generate the key, store only its hash, and return the plaintext once.
      const plaintext = generateApiKey()
      const record = await prisma.apiKey.create({
        data: {
          hash: hashApiKey(plaintext),
          label,
          ...(expiration ? { expiresAt: expiration } : {}),
          ...(ratePerMin !== undefined ? { ratePerMin } : {}),
          ...(ratePerDay !== undefined ? { ratePerDay } : {}),
          ...(monthlyQuotaCents !== undefined ? { monthlyQuotaCents } : {}),
          ...(dailyQuotaCents !== undefined ? { dailyQuotaCents } : {}),
          ...(overagePolicy !== undefined ? { overagePolicy } : {}),
        },
      })

      return reply.status(201).send({
        id: record.id,
        label: record.label,
        expiresAt: record.expiresAt,
        ratePerMin: record.ratePerMin,
        ratePerDay: record.ratePerDay,
        monthlyQuotaCents: record.monthlyQuotaCents,
        dailyQuotaCents: record.dailyQuotaCents,
        overagePolicy: record.overagePolicy,
        key: plaintext,
        createdAt: record.createdAt,
      })
    },
  )

  app.delete<{ Params: { id: string } }>(
    '/admin/keys/:id',
    { config: { public: true } },
    async (req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      if (!isAdminAuthorized(req)) {
        admin_auth_failures_total.inc()
        return reply.status(401).send({
          error: 'Unauthorized',
          code: 'admin_unauthorized',
          message: 'Provide a valid X-Admin-Token header.',
        })
      }

      const { id } = req.params
      const existing = await prisma.apiKey.findUnique({ where: { id } })
      if (!existing) {
        return reply.status(404).send({ error: 'API key not found' })
      }
      if (existing.revokedAt) {
        return reply.status(200).send({ id, revoked: true, alreadyRevoked: true })
      }

      await prisma.apiKey.update({
        where: { id },
        data: { revokedAt: new Date() },
      })

      return reply.status(200).send({ id, revoked: true })
    },
  )
}
