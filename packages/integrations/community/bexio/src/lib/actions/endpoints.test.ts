import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PropertyType } from '@inboxfm-connect/pieces-framework';
import { HttpError } from '@inboxfm-connect/pieces-common';
import { createTimeTrackingAction } from './create-time-tracking';
import { createProductAction } from './create-product';
import { updateProductAction } from './update-product';
import { BexioClient } from '../common/client';
import { extractErrorMessage } from '../common';
import { bexioAuth } from '../auth';

vi.mock('../common/client', () => {
  return {
    BexioClient: vi.fn(),
  };
});

describe('Bexio Dropdown Endpoints & Error Handling', () => {
  const mockAuth = { access_token: 'fake-token' };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('bexioAuth scopes (#185)', () => {
    it('requests general and stock_edit OAuth scopes required for verified dropdown endpoints', () => {
      expect(bexioAuth.scope).toContain('general');
      expect(bexioAuth.scope).toContain('stock_edit');
    });
  });

  describe('extractErrorMessage helper (#185)', () => {
    it('extracts human-readable message from serialized HttpError JSON string', () => {
      const serialized = JSON.stringify({
        response: {
          status: 403,
          body: { message: 'Insufficient permissions for stock_edit' },
        },
        request: { body: {} },
      });
      const result = extractErrorMessage(new Error(serialized), 'fallback');
      expect(result).toBe('Insufficient permissions for stock_edit');
    });

    it('extracts status code if serialized HttpError body has no message', () => {
      const serialized = JSON.stringify({
        response: {
          status: 404,
          body: {},
        },
        request: { body: {} },
      });
      const result = extractErrorMessage(new Error(serialized), 'fallback');
      expect(result).toBe('HTTP 404');
    });

    it('extracts message from HttpError instance', () => {
      const httpErr = new HttpError({}, {
        status: 401,
        responseBody: { message: 'Token expired' },
      });
      const result = extractErrorMessage(httpErr, 'fallback');
      expect(result).toBe('Token expired');
    });

    it('extracts message from error object with response.data.message', () => {
      const err = { response: { data: { message: 'Rate limit exceeded' } } };
      const result = extractErrorMessage(err, 'fallback');
      expect(result).toBe('Rate limit exceeded');
    });

    it('returns standard Error message or fallback for unformatted errors', () => {
      expect(extractErrorMessage(new Error('Network timeout'), 'fallback')).toBe(
        'Network timeout'
      );
      expect(extractErrorMessage(null, 'Default fallback')).toBe('Default fallback');
    });
  });

  describe('createTimeTrackingAction', () => {
    it('timesheet status dropdown should call /2.0/timesheet_status and return options', async () => {
      const mockGet = vi.fn().mockResolvedValue([
        { id: 1, name: 'Open' },
        { id: 2, name: 'Done' },
      ]);
      (BexioClient as any).mockImplementation(() => ({
        get: mockGet,
      }));

      const statusProp = createTimeTrackingAction.props.status_id as any;
      const result = await statusProp.options({ auth: mockAuth });

      expect(mockGet).toHaveBeenCalledWith('/2.0/timesheet_status');
      expect(result.disabled).toBe(false);
      expect(result.options).toEqual([
        { label: 'Open', value: 1 },
        { label: 'Done', value: 2 },
      ]);
    });

    it('timesheet status dropdown should return diagnostic placeholder on failure instead of empty options', async () => {
      const mockGet = vi.fn().mockRejectedValue(new Error('Network error'));
      (BexioClient as any).mockImplementation(() => ({
        get: mockGet,
      }));

      const statusProp = createTimeTrackingAction.props.status_id as any;
      const result = await statusProp.options({ auth: mockAuth });

      expect(result.disabled).toBe(true);
      expect(result.placeholder).toBe('Connection test failed: Network error');
      expect(result.options).toEqual([]);
    });

    it('timesheet status dropdown extracts readable message from serialized HttpError', async () => {
      const httpError = new HttpError({}, {
        status: 403,
        responseBody: { message: 'Scope general is required' },
      });
      const mockGet = vi.fn().mockRejectedValue(httpError);
      (BexioClient as any).mockImplementation(() => ({
        get: mockGet,
      }));

      const statusProp = createTimeTrackingAction.props.status_id as any;
      const result = await statusProp.options({ auth: mockAuth });

      expect(result.disabled).toBe(true);
      expect(result.placeholder).toBe('Connection test failed: Scope general is required');
      expect(result.options).toEqual([]);
    });

    it('client service dropdown should call /2.0/client_service and return options', async () => {
      const mockGet = vi
        .fn()
        .mockResolvedValue([{ id: 10, name: 'Consulting' }]);
      (BexioClient as any).mockImplementation(() => ({
        get: mockGet,
      }));

      const serviceProp = createTimeTrackingAction.props
        .client_service_id as any;
      const result = await serviceProp.options({ auth: mockAuth });

      expect(mockGet).toHaveBeenCalledWith('/2.0/client_service');
      expect(result.disabled).toBe(false);
      expect(result.options).toEqual([{ label: 'Consulting', value: 10 }]);
    });

    it('client service dropdown should return diagnostic placeholder on failure', async () => {
      const mockGet = vi.fn().mockRejectedValue(new Error('API 500'));
      (BexioClient as any).mockImplementation(() => ({
        get: mockGet,
      }));

      const serviceProp = createTimeTrackingAction.props
        .client_service_id as any;
      const result = await serviceProp.options({ auth: mockAuth });

      expect(result.disabled).toBe(true);
      expect(result.placeholder).toBe('Connection test failed: API 500');
      expect(result.options).toEqual([]);
    });
  });

  describe('createProductAction', () => {
    it('stock dropdown should call /2.0/stock and return options', async () => {
      const mockGet = vi
        .fn()
        .mockResolvedValue([{ id: 100, name: 'Main Warehouse' }]);
      (BexioClient as any).mockImplementation(() => ({
        get: mockGet,
      }));

      const stockProp = createProductAction.props.stock_id as any;
      const result = await stockProp.options({ auth: mockAuth });

      expect(mockGet).toHaveBeenCalledWith('/2.0/stock');
      expect(result.disabled).toBe(false);
      expect(result.options).toEqual([{ label: 'Main Warehouse', value: 100 }]);
    });

    it('stock dropdown should return diagnostic placeholder on failure', async () => {
      const mockGet = vi.fn().mockRejectedValue(new Error('Unauthorized'));
      (BexioClient as any).mockImplementation(() => ({
        get: mockGet,
      }));

      const stockProp = createProductAction.props.stock_id as any;
      const result = await stockProp.options({ auth: mockAuth });

      expect(result.disabled).toBe(true);
      expect(result.placeholder).toBe('Connection test failed: Unauthorized');
      expect(result.options).toEqual([]);
    });

    it('stock place dropdown should call /2.0/stock_place and return options', async () => {
      const mockGet = vi.fn().mockResolvedValue([{ id: 200, name: 'Aisle 3' }]);
      (BexioClient as any).mockImplementation(() => ({
        get: mockGet,
      }));

      const placeProp = createProductAction.props.stock_place_id as any;
      const result = await placeProp.options({ auth: mockAuth });

      expect(mockGet).toHaveBeenCalledWith('/2.0/stock_place');
      expect(result.disabled).toBe(false);
      expect(result.options).toEqual([{ label: 'Aisle 3', value: 200 }]);
    });

    it('stock place dropdown should return diagnostic placeholder on failure', async () => {
      const mockGet = vi.fn().mockRejectedValue(new Error('Forbidden: stock_edit scope missing'));
      (BexioClient as any).mockImplementation(() => ({
        get: mockGet,
      }));

      const placeProp = createProductAction.props.stock_place_id as any;
      const result = await placeProp.options({ auth: mockAuth });

      expect(result.disabled).toBe(true);
      expect(result.placeholder).toBe('Connection test failed: Forbidden: stock_edit scope missing');
      expect(result.options).toEqual([]);
    });

    it('article_group_id is a numeric property rather than an unverified dropdown (#185)', () => {
      const articleGroupProp = createProductAction.props.article_group_id;
      expect(articleGroupProp.type).toBe(PropertyType.NUMBER);
      expect((articleGroupProp as any).options).toBeUndefined();
    });
  });

  describe('updateProductAction', () => {
    it('update product stock and stock_place dropdowns call verified endpoints', async () => {
      const mockGet = vi.fn().mockImplementation((endpoint: string) => {
        if (endpoint === '/2.0/stock')
          return Promise.resolve([{ id: 1, name: 'Warehouse' }]);
        if (endpoint === '/2.0/stock_place')
          return Promise.resolve([{ id: 2, name: 'Shelf B' }]);
        return Promise.reject(new Error('Unknown endpoint'));
      });
      (BexioClient as any).mockImplementation(() => ({
        get: mockGet,
      }));

      const stockRes = await (
        updateProductAction.props.stock_id as any
      ).options({ auth: mockAuth });
      const placeRes = await (
        updateProductAction.props.stock_place_id as any
      ).options({ auth: mockAuth });

      expect(stockRes.disabled).toBe(false);
      expect(placeRes.disabled).toBe(false);
      expect(mockGet).toHaveBeenCalledWith('/2.0/stock');
      expect(mockGet).toHaveBeenCalledWith('/2.0/stock_place');
    });

    it('update product stock and stock_place dropdowns return diagnostic placeholders on failure', async () => {
      const mockGet = vi.fn().mockRejectedValue(new Error('Service Unavailable'));
      (BexioClient as any).mockImplementation(() => ({
        get: mockGet,
      }));

      const stockRes = await (
        updateProductAction.props.stock_id as any
      ).options({ auth: mockAuth });
      const placeRes = await (
        updateProductAction.props.stock_place_id as any
      ).options({ auth: mockAuth });

      expect(stockRes.disabled).toBe(true);
      expect(stockRes.placeholder).toBe('Connection test failed: Service Unavailable');
      expect(stockRes.options).toEqual([]);

      expect(placeRes.disabled).toBe(true);
      expect(placeRes.placeholder).toBe('Connection test failed: Service Unavailable');
      expect(placeRes.options).toEqual([]);
    });

    it('article_group_id is a numeric property on updateProductAction (#185)', () => {
      const articleGroupProp = updateProductAction.props.article_group_id;
      expect(articleGroupProp.type).toBe(PropertyType.NUMBER);
      expect((articleGroupProp as any).options).toBeUndefined();
    });
  });
});
