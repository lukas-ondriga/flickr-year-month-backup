var habitat = require("habitat"),
    env = habitat.load(),
    Flickr = require('flickrapi'),
    fs = require('fs'),
    https = require('https'),
    FlickrOptions = env.get("FLICKR");

function setBaseOptions(flickr, result, options)
{
    options.api_key = flickr.options.api_key;
    options.user_id = flickr.options.user_id;
    options.authenticated = true;
    return options;
}

function setLastResult(flickr, result, options)
{
    options.result = result;
    return options;
}

function createDirectoryIfDoesNotExist(dir)
{
    if (!fs.existsSync(dir)){
        fs.mkdirSync(dir);
    }
}

/**
 * Check whether or not the JPG ends in 0xFFD9.
 */
function validateJPG(file, cb) {
    var data = fs.readFileSync(file),
        len = data.length,
        last = data.slice(len-2,len),
        ends = (last[0] === 0xFF && last[1] === 0xD9);
    cb(ends ? false : "jpg file "+file+" is incomplete.");
}

/**
 * Check whether the png file has an IEND block.
 */
function validatePNG(file, cb) {
    var data = fs.readFileSync(file),
        ends = data.toString().indexOf("IEND") > -1;
    cb(ends ? false : "png file "+file+" is incomplete.");
}

/**
 * Validate a downloaded jpg/png file
 */
function validateFile(dest, cb) {
    if(dest.indexOf(".jpg") > -1 || dest.indexOf(".JPG") > -1) {
        validateJPG(dest, cb);
    }
    else if(dest.indexOf(".png") > -1 || dest.indexOf(".PNG") > -1) {
        validatePNG(dest, cb);
    }
    // no idea how to validate. So just claim it's fine.
    else { cb(false); }
}
/**
 * Retrieve image resources from the web
 */
function getFromURL(url, dest, retries, handler) {

    if (retries > 5) {
        var err = "Maximum number of retries reached for " + dest;
        console.error(err);
        return handler ? handler(err) : false;
    }

    var file = fs.createWriteStream(dest),
        handleRequest = function(response) {
            response.pipe(file);
            file.on('finish', function() {
                    file.close();
                    validateFile(dest, function(err) {
                        if(err) {
                            console.error(err);
                            retries++;
                            return getFromURL(url, dest, retries, handler);
                        }
                    });
                    handler();
            });
        },
        errorHandler = function(err) {
            console.error(err);
            handler(err);
        };
    https.get(url, handleRequest).on('error', errorHandler);
}

Flickr.authenticate(FlickrOptions, function(error, flickr) {

    var util = require('util');

    var actualPhotoMetaData = {
        baseDir: flickr.options.backup_dir,
        pageIndex: 1,
        photoCounter: -1,
        photoIndex: 0,
        perPage: 100
    };

    function nextPhoto(result, call)
    {
        var photoNumber = ++actualPhotoMetaData.photoCounter;
        actualPhotoMetaData.pageIndex = Math.floor((photoNumber / actualPhotoMetaData.perPage) + 1);
        actualPhotoMetaData.photoIndex = photoNumber % actualPhotoMetaData.perPage;

        call();
    }

    function setActualPage(flickr, result, options)
    {
        options.page = actualPhotoMetaData.pageIndex;
        return options;
    }

    function isNewPage()
    {
        return actualPhotoMetaData.photoIndex == 0;
    }

    function processOldPage(result, nextCall)
    {
        nextCall(undefined, actualPhotoMetaData.oldPage);
    }

    function setActualPhotoId(result)
    {
        console.log("Processing photo ", actualPhotoMetaData.photoCounter + 1, "/", result.photos.total);
        if(actualPhotoMetaData.photoCounter >= result.photos.total)
        {
            process.exit();
        }
        actualPhotoMetaData.id = result.photos.photo[actualPhotoMetaData.photoIndex].id;
        actualPhotoMetaData.oldPage = result;
        actualPhotoMetaData.perPage = result.photos.perpage;
    }

    function setPhotoId(flickr, result, options)
    {
        options.photo_id = actualPhotoMetaData.id;
        return options;
    }


    function prepareFilePath(result)
    {
        actualPhotoMetaData.fileName = result.photo.title._content;
        actualPhotoMetaData.taken = result.photo.dates.taken;
        const year = actualPhotoMetaData.taken.substring(0,4);
        const yearMonth = actualPhotoMetaData.taken.substring(0,7);
        actualPhotoMetaData.path = actualPhotoMetaData.baseDir + "/" + year;
        createDirectoryIfDoesNotExist(actualPhotoMetaData.path);
        actualPhotoMetaData.path += "/" + yearMonth;
        createDirectoryIfDoesNotExist(actualPhotoMetaData.path);
        actualPhotoMetaData.path += "/" + actualPhotoMetaData.fileName;

    }

    function printActualPhotoMetaData(result)
    {
        console.log(actualPhotoMetaData);
        console.log(result.sizes.size.slice(-1)[0]);
    }

    function getPhoto(result, nextCall)
    {
        actualPhotoMetaData.url = result.sizes.size.slice(-1)[0].source;
        if (fs.existsSync(actualPhotoMetaData.path))
        {
            console.log("Photo", actualPhotoMetaData.path, "already exists.");
            nextCall();
        }
        else
        {
            getFromURL(actualPhotoMetaData.url, actualPhotoMetaData.path, 0, nextCall);
        }
    }

    function resultProcessor(call)
    {
        return {
               getParams: pipeParamConstruction(setLastResult),
               execute: (params, nextCall) => { call(params.result); nextCall(undefined, params.result); }
        };
    }
    function resultProcessorCallback(call)
    {
        return {
               getParams: pipeParamConstruction(setLastResult),
               execute: (params, nextCall) => { call(params.result, nextCall); }
        };
    }
    function flickrCall(call, ...paramSetters)
    {
        return {
               getParams: pipeParamConstruction(...paramSetters),
               execute: call
        };
    }
    function flickrCallIf(statement, callTrue, callFalse, ...paramSetters)
    {
        return {
               getParams: pipeParamConstruction(...paramSetters),
               execute: statement ? callTrue : callFalse
        };
        return flickrCall(call, ...paramSetters)
    }

    var composeFlickrCalls = (...functionObjects) => (lastCall) =>  functionObjects.reduceRight((nextCall, functionObject) =>
    {
        return function(err, result)
        {
               functionObject.execute(functionObject.getParams(flickr, result), nextCall);
        };
    }, lastCall);

    var pipeParamConstruction = (...functions) => (flickr, params) => functions.reduce((options, call) => call(flickr, params, options), {});

    console.log("Starting backup")

    var exec = composeFlickrCalls(
    resultProcessorCallback(nextPhoto),
    flickrCallIf(isNewPage, flickr.photos.search, processOldPage,  setBaseOptions, setActualPage),
    resultProcessor(setActualPhotoId),
    flickrCall(flickr.photos.getInfo, setBaseOptions, setPhotoId),
    resultProcessor(prepareFilePath),
    flickrCall(flickr.photos.getSizes, setBaseOptions, setPhotoId),
    resultProcessorCallback(getPhoto)
    );

    function lastCall(err, result)
    {
        exec(lastCall)();
    }

    exec(lastCall)();




});
