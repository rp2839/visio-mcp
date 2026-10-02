// Types for the generated Ajv standalone validators (validators.js).
type Validator = ((data: unknown) => boolean) & { errors?: unknown[] | null };
export declare const validateDocumentSchema: Validator;
export declare const validateElementSchemaFn: Validator;
export declare const validateOperationBatch: Validator;
export declare const validateRequestEnvelope: Validator;
export declare const validateMutationRequest: Validator;
export declare const validateScriptRequest: Validator;
