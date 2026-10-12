import { createAction, Property } from '@inboxfm-connect/pieces-framework';
import { predefinedMimeTypes } from '../common/mimeTypes';
import mime from 'mime-types';

export const checkFileType = createAction({
  audience: 'human',
  name: 'checkFileType',
  displayName: 'Check file type',
  description: 'Check MIME type of a file and filter based on selected types',
  props: {
    file: Property.File({
      displayName: 'File to Check',
      required: true,
    }),
    mimeTypes: Property.StaticDropdown({
      displayName: 'Select MIME Types',
      required: true,
      options: {
        options: predefinedMimeTypes,
      }, 
      description: 'Choose one or more MIME types to check against the file.',
    }),
  },
  async run(context) {
    const file = context.propsValue.file;
    
    const selectedMimeTypes = context.propsValue.mimeTypes;

    // Determine the MIME type of the file
    const fileType = file.extension ? mime.lookup(file.extension) || 'application/octet-stream' : 'application/octet-stream';

    // Check if the file's MIME type exactly matches the selected MIME type(s).
    // `mimeTypes` is a single-select dropdown, so the value is a string and
    // `includes` was String.prototype.includes — a substring match that let
    // e.g. a .3gp file (video/3gpp) pass a video/3gpp2 filter (#557). Accept
    // arrays too, so a future multi-select dropdown keeps working unchanged.
    const isMatch = Array.isArray(selectedMimeTypes)
        ? selectedMimeTypes.includes(fileType)
        : selectedMimeTypes === fileType;

    return {
      mimeType: fileType || 'unknown',
      isMatch,
    };
  },
});
