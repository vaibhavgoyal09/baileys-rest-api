const Joi = require('joi');

const sendText = Joi.object({
  to: Joi.string().required(),
  message: Joi.string().required(),
});

const checkNumber = Joi.object({
  to: Joi.string().required(),
});

module.exports = {
  sendText,
  checkNumber,
};
