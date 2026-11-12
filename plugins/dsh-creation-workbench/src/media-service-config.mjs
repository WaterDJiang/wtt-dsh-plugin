import z from '@deepseek-ai/schemastery';

export const Config = z.object({
  mediaServices: z.dict(z.object({
    displayName: z.string().required(),
    baseURL: z.string().required(),
    type: z.union(['image', 'video']).required(),
    model: z.string().required(),
    protocol: z.string().required(),
    apiKeyEnv: z.string().role('credential-ref').required(),
    connection: z.union([z.const(null), z.object({ namespace: z.string().required(), path: z.array(z.string()).required() })]).default(null),
  })).default({}).volatile(),
});
