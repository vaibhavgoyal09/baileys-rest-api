import { Request, Response, NextFunction } from 'express';
declare const middleware: (schema: any, property?: string) => (req: Request, res: Response, next: NextFunction) => void;
export default middleware;
//# sourceMappingURL=validator.d.ts.map