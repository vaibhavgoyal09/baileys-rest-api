import Joi from "joi";

const sendText = Joi.object({
  to: Joi.string().required(),
  message: Joi.string().required(),
});

const checkNumber = Joi.object({
  to: Joi.string().required(),
});

const listConversations = Joi.object({
  limit: Joi.number().integer().min(1).max(500).optional(),
  cursor: Joi.number().integer().optional(),
});

const sendMessage = Joi.object({
  to: Joi.string().required(),
  type: Joi.string().valid(
    'text',
    'image',
    'video',
    'audio',
    'document',
    'sticker',
    'location',
    'contact'
  ).required(),
  content: Joi.alternatives().conditional('type', {
    switch: [
      { is: 'text', then: Joi.string().required() },
      { is: 'image', then: Joi.object({
        url: Joi.string().uri().required(),
        caption: Joi.string().optional(),
        mimetype: Joi.string().optional()
      }).required() },
      { is: 'video', then: Joi.object({
        url: Joi.string().uri().required(),
        caption: Joi.string().optional(),
        mimetype: Joi.string().optional()
      }).required() },
      { is: 'audio', then: Joi.object({
        url: Joi.string().uri().required(),
        mimetype: Joi.string().optional()
      }).required() },
      { is: 'document', then: Joi.object({
        url: Joi.string().uri().required(),
        filename: Joi.string().required(),
        mimetype: Joi.string().optional()
      }).required() },
      { is: 'sticker', then: Joi.object({
        url: Joi.string().uri().required(),
        mimetype: Joi.string().optional()
      }).required() },
      { is: 'location', then: Joi.object({
        latitude: Joi.number().required(),
        longitude: Joi.number().required(),
        name: Joi.string().optional(),
        address: Joi.string().optional()
      }).required() },
      { is: 'contact', then: Joi.object({
        name: Joi.string().required(),
        phone: Joi.string().required(),
        vcard: Joi.string().optional()
      }).required() }
    ]
  })
});

export { sendText, checkNumber, listConversations, sendMessage };
