import Joi from "joi";

export const issueToken = Joi.object({
  username: Joi.string().min(3).max(128).required(),
  webhook_url: Joi.string()
    .uri({ scheme: ["http", "https"] })
    .allow(null)
    .optional(),
});

export const setWebhook = Joi.object({
  webhook_url: Joi.string()
    .uri({ scheme: ["http", "https"] })
    .allow(null)
    .required(),
});

export const registerSchema = Joi.object({
  name: Joi.string().min(1).max(100).required().messages({
    "string.min": "Name must be at least 1 character long",
    "string.max": "Name must be less than 100 characters long",
  }),
  email: Joi.string().email().required().messages({
    "string.email": "Please provide a valid email address",
  }),
  password: Joi.string().min(8).required().messages({
    "string.min": "Password must be at least 8 characters long",
  }),
});

export const loginSchema = Joi.object({
  username: Joi.alternatives()
    .try(
      Joi.string().email().messages({
        "string.email": "Please provide a valid email address or username",
      }),
      Joi.string().min(3).max(128).messages({
        "string.min": "Username must be at least 3 characters long",
        "string.max": "Username must be less than 128 characters long",
      }),
    )
    .required()
    .messages({
      "any.required": "Username or email is required",
    }),
  password: Joi.string().min(8).required(),
});
