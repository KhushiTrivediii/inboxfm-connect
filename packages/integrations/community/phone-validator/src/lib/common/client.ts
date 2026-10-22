import { httpClient, HttpMethod } from '@inboxfm-connect/pieces-common';

const BASE_URL = 'https://api.phonevalidator.com';

export class PhoneValidatorClient {
  private apiKey: string;

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  async validatePhone(
    phone: string,
    type: 'basic' | 'fake' = 'basic',
    region: '1' | '2' | '3' = '1'
  ) {
    const response = await httpClient.sendRequest({
      method: HttpMethod.GET,
      url: `${BASE_URL}/api/v4/phonesearch`,
      queryParams: {
        apikey: this.apiKey,
        phone,
        type,
        region,
      },
    });

    return response.body;
  }
}
