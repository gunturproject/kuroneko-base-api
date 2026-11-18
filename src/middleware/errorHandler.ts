/*
 * KuroNeko API | sylvatica.my.id
 * © Dandy
 */
import { Request, Response, NextFunction } from 'express';

export const errorHandler = (
    error: unknown,
    req: Request,
    res: Response,
    next: NextFunction
) => {
    if (res.headersSent) {
        return next(error);
    }

    const status =
        typeof (error as any)?.status === 'number' &&
        (error as any).status >= 400 &&
        (error as any).status < 500
            ? (error as any).status
            : 500;

    const clientMessage =
        status === 400
            ? 'Request tidak valid.'
            : status === 413
                ? 'Payload terlalu besar.'
                : status === 415
                    ? 'Content-Type tidak didukung.'
                    : 'Internal Server Error';

    if (status >= 500) {
        console.error(`[ERROR] ${req.method} ${req.originalUrl}`, error);
    }

    res.setHeader('Cache-Control', 'no-store');
    return res.status(status).json({
        status: false,
        message: clientMessage
    });
};