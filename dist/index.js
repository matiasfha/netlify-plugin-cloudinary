import fs from 'fs-extra';
import path from 'path';
import { glob } from 'glob';
import { configureCloudinary, updateHtmlImagesToCloudinary, getCloudinaryUrl, } from './lib/cloudinary.js';
import { PUBLIC_ASSET_PATH } from './data/cloudinary.js';
import { ERROR_CLOUD_NAME_REQUIRED, ERROR_NETLIFY_HOST_UNKNOWN, ERROR_NETLIFY_HOST_CLI_SUPPORT, ERROR_SITE_NAME_REQUIRED, } from './data/errors.js';
const CLOUDINARY_ASSET_DIRECTORIES = [
    {
        name: 'images',
        inputKey: 'imagesPath',
        path: '/images',
    },
];
/**
 * TODO
 * - Handle srcset
 */
const _cloudinaryAssets = {};
export async function onBuild({ netlifyConfig, constants, inputs, utils }) {
    console.log('[Cloudinary] Creating redirects...');
    const isProduction = process.env.CONTEXT === 'production';
    const host = isProduction
        ? process.env.NETLIFY_HOST
        : process.env.DEPLOY_PRIME_URL;
    if (!host) {
        utils.build.failBuild(ERROR_NETLIFY_HOST_UNKNOWN);
        return;
    }
    console.log(`[Cloudinary] Using host: ${host}`);
    const { PUBLISH_DIR } = constants;
    const { deliveryType, uploadPreset, folder = process.env.SITE_NAME, imagesPath = CLOUDINARY_ASSET_DIRECTORIES.at(0)?.path } = inputs;
    if (!folder) {
        utils.build.failPlugin(ERROR_SITE_NAME_REQUIRED);
        return;
    }
    if (!host && deliveryType === 'fetch') {
        console.warn(`[Cloudinary] ${ERROR_NETLIFY_HOST_UNKNOWN}`);
        console.log(`[Cloudinary] ${ERROR_NETLIFY_HOST_CLI_SUPPORT}`);
        return;
    }
    const cloudName = process.env.CLOUDINARY_CLOUD_NAME || inputs.cloudName;
    const apiKey = process.env.CLOUDINARY_API_KEY;
    const apiSecret = process.env.CLOUDINARY_API_SECRET;
    if (!cloudName || !apiKey || !apiSecret) {
        utils.build.failBuild(JSON.stringify({ env: process.env, netlifyConfig , NETLFY_HOST: process.env.NETLIFY_HOST, DEPLOY_PRIME_URL: process.env.DEPLOY_PRIME_URL }))
        utils.build.failBuild(ERROR_CLOUD_NAME_REQUIRED);
        return;
    }
    configureCloudinary({
        cloudName,
        apiKey,
        apiSecret,
    });
    // Look for any available images in the provided imagesPath to collect
    // asset details and to grab a Cloudinary URL to use later
    const imagesDirectory = glob.sync(`${PUBLISH_DIR}/${imagesPath}/**/*`);
    const imagesFiles = imagesDirectory.filter(file => !!path.extname(file));
    if (imagesFiles.length === 0) {
        console.warn(`[Cloudinary] No image files found in ${imagesPath}`);
        console.log(`[Cloudinary] Did you update your images path? You can set the imagesPath input in your Netlify config.`);
    }
    try {
        _cloudinaryAssets.images = await Promise.all(imagesFiles.map(async (image) => {
            const publishPath = image.replace(PUBLISH_DIR, '');
            const cloudinary = await getCloudinaryUrl({
                deliveryType,
                folder,
                path: publishPath,
                localDir: PUBLISH_DIR,
                uploadPreset,
                remoteHost: host,
            });
            return {
                publishPath,
                ...cloudinary,
            };
        }));
    }
    catch (e) {
        if (e instanceof Error) {
            utils.build.failBuild(e.message);
        }
        else {
            utils.build.failBuild(e);
        }
        return;
    }
    // If the delivery type is set to upload, we need to be able to map individual assets based on their public ID,
    // which would require a dynamic middle solution, but that adds more hops than we want, so add a new redirect
    // for each asset uploaded
    if (deliveryType === 'upload') {
        await Promise.all(Object.keys(_cloudinaryAssets).flatMap(mediaType => {
            // @ts-expect-error what are the expected mediaTypes that will be stored in _cloudinaryAssets
            return _cloudinaryAssets[mediaType].map(async (asset) => {
                const { publishPath, cloudinaryUrl } = asset;
                netlifyConfig.redirects.unshift({
                    from: `${publishPath}*`,
                    to: cloudinaryUrl,
                    status: 302,
                    force: true,
                });
            });
        }));
    }
    // If the delivery type is fetch, we're able to use the public URL and pass it right along "as is", so
    // we can create generic redirects. The tricky thing is to avoid a redirect loop, we modify the
    // path, so that we can safely allow Cloudinary to fetch the media remotely
    if (deliveryType === 'fetch') {
        await Promise.all(CLOUDINARY_ASSET_DIRECTORIES.map(async ({ inputKey, path: defaultPath }) => {
            const mediaPath = inputs[inputKey] || defaultPath;
            const cldAssetPath = `/${path.join(PUBLIC_ASSET_PATH, mediaPath)}`;
            const cldAssetUrl = `${host}/${cldAssetPath}`;
            const { cloudinaryUrl: assetRedirectUrl } = await getCloudinaryUrl({
                deliveryType: 'fetch',
                folder,
                path: `${cldAssetUrl}/:splat`,
                uploadPreset,
            });
            netlifyConfig.redirects.unshift({
                from: `${cldAssetPath}/*`,
                to: `${mediaPath}/:splat`,
                status: 200,
                force: true,
            });
            netlifyConfig.redirects.unshift({
                from: `${mediaPath}/*`,
                to: assetRedirectUrl,
                status: 302,
                force: true,
            });
        }));
    }
    console.log('[Cloudinary] Done.');
}
// Post build looks through all of the output HTML and rewrites any src attributes to use a cloudinary URL
// This only solves on-page references until any JS refreshes the DOM
export async function onPostBuild({ constants, inputs, utils }) {
    console.log('[Cloudinary] Replacing on-page images with Cloudinary URLs...');
    const isProduction = process.env.CONTEXT === 'production';
    const host = isProduction
        ? process.env.NETLIFY_HOST
        : process.env.DEPLOY_PRIME_URL;
    console.log(`[Cloudinary] Using host: ${host}`);
    if (!host) {
        console.warn(`[Cloudinary] ${ERROR_NETLIFY_HOST_UNKNOWN}`);
        console.log(`[Cloudinary] ${ERROR_NETLIFY_HOST_CLI_SUPPORT}`);
        return;
    }
    const { PUBLISH_DIR } = constants;
    const { deliveryType, uploadPreset, folder = process.env.SITE_NAME, } = inputs;
    if (!folder) {
        utils.build.failPlugin(ERROR_SITE_NAME_REQUIRED);
        return;
    }
    const cloudName = process.env.CLOUDINARY_CLOUD_NAME || inputs.cloudName;
    const apiKey = process.env.CLOUDINARY_API_KEY;
    const apiSecret = process.env.CLOUDINARY_API_SECRET;
    if (!cloudName || !apiKey || !apiSecret) {
        utils.build.failBuild(ERROR_CLOUD_NAME_REQUIRED);
        return;
    }
    configureCloudinary({
        cloudName,
        apiKey,
        apiSecret,
    });
    // Find all HTML source files in the publish directory
    const pages = glob.sync(`${PUBLISH_DIR}/**/*.html`);
    const results = await Promise.all(pages.map(async (page) => {
        const sourceHtml = await fs.readFile(page, 'utf-8');
        const { html, errors } = await updateHtmlImagesToCloudinary(sourceHtml, {
            assets: _cloudinaryAssets,
            deliveryType,
            uploadPreset,
            folder,
            localDir: PUBLISH_DIR,
            remoteHost: host,
        });
        await fs.writeFile(page, html);
        return {
            page,
            errors,
        };
    }));
    const errors = results.filter(({ errors }) => errors.length > 0);
    if (errors.length > 0) {
        console.log(`[Cloudinary] Done with ${errors.length} errors...`);
        console.log(JSON.stringify(errors, null, 2));
    }
    else {
        console.log('[Cloudinary] Done.');
    }
}