import Joi from "joi";

// Validator for adding excluded number
export const addExcludedNumber = Joi.object({
  phone_number: Joi.string().pattern(/^\+[1-9]\d{1,14}$/).required().messages({
    'string.pattern.base': 'Phone number must be in international format (e.g., +1234567890)'
  }),
});

// Validator for removing excluded number (for path parameter validation)
export const removeExcludedNumber = Joi.object({
  phoneNumber: Joi.string().pattern(/^\+[1-9]\d{1,14}$/).required().messages({
    'string.pattern.base': 'Phone number must be in international format (e.g., +1234567890)'
  }),
});