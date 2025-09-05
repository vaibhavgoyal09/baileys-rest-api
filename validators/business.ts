import Joi from 'joi';

const urlRegex = /^https?:\/\/[^\s]+$/i;

export const updateBusinessInfo = Joi.object({
  name: Joi.string().allow(null, '').optional(),
  working_hours: Joi.string().allow(null, '').optional(),
  location_url: Joi.string().pattern(urlRegex).allow(null, '').optional(),
  shipping_details: Joi.string().allow(null, '').optional(),
  instagram_url: Joi.string().pattern(urlRegex).allow(null, '').optional(),
  website_url: Joi.string().pattern(urlRegex).allow(null, '').optional(),
  mobile_numbers: Joi.array().items(
    Joi.string().pattern(/^\+?\d{6,18}$/).message('mobile number must be 6-18 digits, optional + prefix')
  ).allow(null).optional(),
});

export const emptyBody = Joi.object({}).optional();