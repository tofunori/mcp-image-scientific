/**
 * File Manager for handling image file operations
 * Provides functionality for saving images and managing directories
 */

import { promises as fs, mkdirSync } from 'node:fs'
import * as path from 'node:path'
import type { Result } from '../types/result'
import { Err, Ok } from '../types/result'
import { FileOperationError } from '../utils/errors'

// Constants for file naming and error messages
const FILE_NAME_PREFIX = 'image' as const
const DEFAULT_EXTENSION = '.png' as const
const RANDOM_RANGE = 1000 as const

/**
 * Detect image format from magic bytes and return appropriate extension
 * @param buffer - Image data buffer
 * @returns File extension including dot (e.g., '.png', '.jpg')
 */
function getExtensionFromMagicBytes(buffer: Buffer): string {
  if (buffer.length < 12) return DEFAULT_EXTENSION

  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) {
    return '.png'
  }

  // JPEG: FF D8 FF
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return '.jpg'
  }

  // GIF: GIF87a or GIF89a
  if (buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x38) {
    return '.gif'
  }

  // BMP: BM
  if (buffer[0] === 0x42 && buffer[1] === 0x4d) {
    return '.bmp'
  }

  // WEBP: RIFF....WEBP
  if (
    buffer[0] === 0x52 &&
    buffer[1] === 0x49 &&
    buffer[2] === 0x46 &&
    buffer[3] === 0x46 &&
    buffer[8] === 0x57 &&
    buffer[9] === 0x45 &&
    buffer[10] === 0x42 &&
    buffer[11] === 0x50
  ) {
    return '.webp'
  }

  return DEFAULT_EXTENSION
}

const ERROR_MESSAGES = {
  SAVE_FAILED: 'Failed to save image file',
  DIRECTORY_CREATION_FAILED: 'Failed to create directory',
  PERMISSION_SUGGESTION: 'Check output directory permissions and disk space',
  PATH_SUGGESTION: 'Check directory path validity and write permissions',
} as const

/**
 * Interface for file management operations
 */
export interface FileManager {
  saveImage(
    imageData: Buffer,
    outputPath: string,
    format?: string
  ): Promise<Result<string, FileOperationError>>
  ensureDirectoryExists(dirPath: string): Result<void, FileOperationError>
  generateFileName(imageData?: Buffer): string
}

/**
 * Ensures that the specified directory exists, creating it if necessary
 * @param dirPath Path to the directory
 * @returns Result indicating success or failure
 */
function ensureDirectoryExists(dirPath: string): Result<void, FileOperationError> {
  try {
    // Use mkdirSync with recursive option to create all necessary parent directories
    mkdirSync(dirPath, { recursive: true })
    return Ok(undefined)
  } catch (error) {
    return Err(
      new FileOperationError(
        `${ERROR_MESSAGES.DIRECTORY_CREATION_FAILED}: ${error instanceof Error ? error.message : 'Unknown error'}`
      )
    )
  }
}

/**
 * Generates a unique filename based on timestamp and random component
 * @param imageData Optional buffer to detect actual image format
 * @returns Generated filename with correct extension based on actual image format
 */
function generateFileName(imageData?: Buffer): string {
  const timestamp = Date.now()
  const random = Math.floor(Math.random() * RANDOM_RANGE)
  const extension = imageData ? getExtensionFromMagicBytes(imageData) : DEFAULT_EXTENSION
  return `${FILE_NAME_PREFIX}-${timestamp}-${random}${extension}`
}

/**
 * Creates a file manager for image file operations
 * @returns FileManager implementation
 */
export function createFileManager(): FileManager {
  return {
    /**
     * Saves image data to the specified file path
     * @param imageData Buffer containing the image data
     * @param outputPath Absolute path where the image should be saved
     * @param format Image format (used for validation)
     * @returns Result containing the saved file path or an error
     */
    async saveImage(
      imageData: Buffer,
      outputPath: string,
      _format?: string
    ): Promise<Result<string, FileOperationError>> {
      try {
        // Ensure the directory exists
        const directory = path.dirname(outputPath)
        const dirResult = ensureDirectoryExists(directory)
        if (!dirResult.success) {
          return Err(dirResult.error)
        }

        // Save the file
        await fs.writeFile(outputPath, imageData)

        return Ok(outputPath)
      } catch (error) {
        return Err(
          new FileOperationError(
            `${ERROR_MESSAGES.SAVE_FAILED}: ${error instanceof Error ? error.message : 'Unknown error'}`
          )
        )
      }
    },

    ensureDirectoryExists,
    generateFileName,
  }
}
