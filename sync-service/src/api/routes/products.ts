import { Router, type Request, type Response } from 'express';
import logger from '../../utils/logger.js';

const router = Router();

// GET /products — Serve cached FGPackConfig for the web-ui dropdown
router.get('/', (req: Request, res: Response) => {
  const { queries } = req.ctx;

  try {
    const products = queries.getProducts();
    res.json(products);
  } catch (err: unknown) {
    const error = err instanceof Error ? err.message : String(err);
    logger.error({ error }, 'Failed to get products');
    res.status(500).json({ status: 'error', error });
  }
});

export const productsRouter = router;
