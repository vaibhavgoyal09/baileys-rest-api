import Joi from 'joi';
const sendText = Joi.object({
    to: Joi.string().required(),
    message: Joi.string().required(),
});
const checkNumber = Joi.object({
    to: Joi.string().required(),
});
const listConversations = Joi.object({
    limit: Joi.number().integer().min(1).max(500)
        .optional(),
    cursor: Joi.number().integer().optional(),
});
export { sendText, checkNumber, listConversations, };
//# sourceMappingURL=message.js.map