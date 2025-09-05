import Joi from 'joi';

export const issueToken = Joi.object({
  tenantId: Joi.string().min(3).max(128).required(),
  webhook_url: Joi.string()
    .uri({ scheme: ['http', 'https'] })
    .allow(null)
    .optional(),
});

export const setWebhook = Joi.object({
  webhook_url: Joi.string()
    .uri({ scheme: ['http', 'https'] })
    .allow(null)
    .required(),
});